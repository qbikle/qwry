//! Editable-results pipeline. After a SELECT runs (simple protocol, text
//! values), we `prepare()` the same statement — the RowDescription gives each
//! result column's source table OID + attnum WITHOUT re-executing. Columns map
//! back to real tables; if a table's full PK is present in the result set, its
//! cells are editable and edits become `UPDATE … WHERE pk = …` in one
//! transaction, with RETURNING to refresh the grid.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::splitter::split_statements;
use super::{map_pg_err, PgSession};
use crate::driver::{DriverError, Result};

#[derive(Debug, Clone, Serialize)]
pub struct ColumnEditMeta {
    /// result-column index
    pub col: u32,
    pub table_oid: u32,
    pub attnum: i16,
    pub editable: bool,
    /// human reason when not editable
    pub reason: Option<String>,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditabilityMap {
    pub statement_index: u32,
    pub columns: Vec<ColumnEditMeta>,
    /// per source table_oid: which result columns hold its full PK
    pub pk_cols: HashMap<u32, Vec<u32>>,
    /// table_oid → "schema.name"
    pub tables: HashMap<u32, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RowEdit {
    pub table_oid: u32,
    /// result-column index being edited
    pub col: u32,
    /// new value as text; None = SET NULL
    pub value: Option<String>,
    /// (result-column index, text value) pairs identifying the row by PK
    pub pk: Vec<(u32, Option<String>)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditResult {
    pub ok: bool,
    pub message: Option<String>,
    /// refreshed value via RETURNING (wire text)
    pub new_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditOutcome {
    pub results: Vec<EditResult>,
    pub committed: bool,
}

/// quote an identifier for SQL
fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// quote a text literal
fn ql(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// "schema.name" → "schema"."name"
fn table_path(dotted: &str) -> String {
    match dotted.split_once('.') {
        Some((s, n)) => format!("{}.{}", qi(s), qi(n)),
        None => qi(dotted),
    }
}

impl PgSession {
    /// Build the editability map for one statement of the last-run SQL.
    pub async fn editability(&self, sql: &str, statement_index: u32) -> Result<EditabilityMap> {
        let stmts = split_statements(sql);
        let stmt_sql = stmts
            .get(statement_index as usize)
            .ok_or_else(|| DriverError::Internal("statement index out of range".into()))?;

        let prepared = self.client.prepare(stmt_sql).await.map_err(map_pg_err)?;

        let oids: Vec<u32> = {
            let mut v: Vec<u32> = prepared
                .columns()
                .iter()
                .filter_map(|c| c.table_oid())
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        };

        let mut table_names: HashMap<u32, String> = HashMap::new();
        let mut table_pks: HashMap<u32, Vec<i16>> = HashMap::new();
        if !oids.is_empty() {
            let oid_list = oids
                .iter()
                .map(|o| o.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let q = format!(
                "SELECT c.oid::int8, n.nspname || '.' || c.relname,
                        coalesce((SELECT array_to_string(i.indkey::int2[], ',')
                                  FROM pg_index i
                                  WHERE i.indrelid = c.oid AND i.indisprimary), '')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.oid IN ({oid_list})"
            );
            let out = self.execute_simple(&q).await?;
            for row in &out.statements[0].rows {
                let oid: u32 = row[0].as_deref().unwrap_or("0").parse().unwrap_or(0);
                table_names.insert(oid, row[1].clone().unwrap_or_default());
                let pks: Vec<i16> = row[2]
                    .as_deref()
                    .unwrap_or("")
                    .split(',')
                    .filter_map(|s| s.trim().parse().ok())
                    .collect();
                table_pks.insert(oid, pks);
            }
        }

        // which result columns expose which (table_oid, attnum)?
        let mut have: HashMap<(u32, i16), u32> = HashMap::new();
        for (i, c) in prepared.columns().iter().enumerate() {
            if let (Some(oid), Some(att)) = (c.table_oid(), c.column_id()) {
                have.entry((oid, att)).or_insert(i as u32);
            }
        }

        // per table: full PK present in the result set?
        let mut pk_cols: HashMap<u32, Vec<u32>> = HashMap::new();
        for (&oid, pks) in &table_pks {
            if pks.is_empty() {
                continue;
            }
            let cols: Vec<u32> = pks
                .iter()
                .filter_map(|att| have.get(&(oid, *att)).copied())
                .collect();
            if cols.len() == pks.len() {
                pk_cols.insert(oid, cols);
            }
        }

        let columns = prepared
            .columns()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let table_oid = c.table_oid();
                let attnum = c.column_id();
                let (editable, reason) = match (table_oid, attnum) {
                    (None, _) => (false, Some("computed expression — no source table".into())),
                    (_, None) => (false, Some("not a plain table column".into())),
                    (Some(oid), Some(_)) => {
                        if table_pks.get(&oid).is_none_or(|p| p.is_empty()) {
                            (false, Some("source table has no primary key".into()))
                        } else if !pk_cols.contains_key(&oid) {
                            (
                                false,
                                Some("primary key not in result — add it to the SELECT".into()),
                            )
                        } else {
                            (true, None)
                        }
                    }
                };
                ColumnEditMeta {
                    col: i as u32,
                    table_oid: table_oid.unwrap_or(0),
                    attnum: attnum.unwrap_or(0),
                    editable,
                    reason,
                    type_name: c.type_().name().to_string(),
                }
            })
            .collect();

        Ok(EditabilityMap {
            statement_index,
            columns,
            pk_cols,
            tables: table_names,
        })
    }

    /// Generate the UPDATE statements for a set of edits (no execution).
    pub async fn build_edit_statements(
        &self,
        sql: &str,
        statement_index: u32,
        edits: &[RowEdit],
    ) -> Result<Vec<String>> {
        let map = self.editability(sql, statement_index).await?;
        let col_meta = |idx: u32| map.columns.iter().find(|c| c.col == idx);

        let mut out = Vec::with_capacity(edits.len());
        for e in edits {
            let table = map
                .tables
                .get(&e.table_oid)
                .ok_or_else(|| DriverError::Internal("unknown table in edit".into()))?;
            let meta = col_meta(e.col)
                .filter(|m| m.editable && m.table_oid == e.table_oid)
                .ok_or_else(|| DriverError::Internal(format!("column {} not editable", e.col)))?;

            let mut where_parts: Vec<(i16, String)> = Vec::new();
            for (pk_col, pk_val) in &e.pk {
                let pk_meta = col_meta(*pk_col)
                    .ok_or_else(|| DriverError::Internal("bad pk column".into()))?;
                let rhs = match pk_val {
                    None => "IS NULL".to_string(),
                    Some(v) => format!("= {}::{}", ql(v), pk_meta.type_name),
                };
                where_parts.push((pk_meta.attnum, rhs));
            }

            let attnums: Vec<i16> = std::iter::once(meta.attnum)
                .chain(where_parts.iter().map(|(a, _)| *a))
                .collect();
            let names = self.attnames(e.table_oid, &attnums).await?;
            let set_name = names
                .get(&meta.attnum)
                .ok_or_else(|| DriverError::Internal("column name lookup failed".into()))?;

            let value_sql = match &e.value {
                None => "NULL".to_string(),
                Some(v) => format!("{}::{}", ql(v), meta.type_name),
            };
            let where_sql = where_parts
                .iter()
                .map(|(att, rhs)| {
                    let n = names.get(att).cloned().unwrap_or_default();
                    format!("{} {}", qi(&n), rhs)
                })
                .collect::<Vec<_>>()
                .join(" AND ");

            out.push(format!(
                "UPDATE {} SET {} = {} WHERE {} RETURNING {}::text",
                table_path(table),
                qi(set_name),
                value_sql,
                where_sql,
                qi(set_name),
            ));
        }
        Ok(out)
    }

    /// Apply edits in ONE transaction. Values are text with a cast to the
    /// column's type — same semantics as typing them in psql.
    pub async fn apply_edits(
        &self,
        sql: &str,
        statement_index: u32,
        edits: Vec<RowEdit>,
    ) -> Result<EditOutcome> {
        let updates = self
            .build_edit_statements(sql, statement_index, &edits)
            .await?;
        let mut statements = vec!["BEGIN".to_string()];
        statements.extend(updates);
        statements.push("COMMIT".to_string());
        let batch = statements.join(";\n");

        match self.execute_simple(&batch).await {
            Ok(out) => {
                let mut results = Vec::new();
                for stmt in out.statements.iter().skip(1).take(edits.len()) {
                    let ok = stmt.rows.len() == 1;
                    results.push(EditResult {
                        ok,
                        message: if ok {
                            None
                        } else {
                            Some(format!("{} rows matched (expected 1)", stmt.rows.len()))
                        },
                        new_value: stmt.rows.first().and_then(|r| r.first().cloned()).flatten(),
                    });
                }
                Ok(EditOutcome { results, committed: true })
            }
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                Err(e)
            }
        }
    }

    async fn attnames(&self, table_oid: u32, attnums: &[i16]) -> Result<HashMap<i16, String>> {
        let list = attnums
            .iter()
            .map(|a| a.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let q = format!(
            "SELECT attnum::int2, attname FROM pg_attribute
             WHERE attrelid = {table_oid} AND attnum IN ({list})"
        );
        let out = self.execute_simple(&q).await?;
        let mut m = HashMap::new();
        for row in &out.statements[0].rows {
            if let (Some(a), Some(n)) = (&row[0], &row[1]) {
                if let Ok(att) = a.parse::<i16>() {
                    m.insert(att, n.clone());
                }
            }
        }
        Ok(m)
    }
}
