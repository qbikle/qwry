//! Editable-results pipeline. After a SELECT runs (simple protocol, text
//! values), we `prepare()` the same statement — the RowDescription gives each
//! result column's source table OID + attnum WITHOUT re-executing. Columns map
//! back to real tables; if a table's full PK is present in the result set, its
//! cells are editable and edits become `UPDATE … WHERE pk = …` in one
//! transaction, with RETURNING to refresh the grid.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::splitter::split_statements;
use super::{map_pg_err, PgSession};
use crate::driver::{DriverError, ExecOutcome, Result};

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
    /// this result column is the table's `ctid` (used as a row locator)
    pub is_ctid: bool,
    /// soft warning shown on an editable cell (e.g. "editing via ctid")
    pub warn: Option<String>,
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

/// One planned UPDATE (one edited row) plus the original edit indices in the
/// same order as its RETURNING columns.
struct PlannedUpdate {
    sql: String,
    edit_indices: Vec<usize>,
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

        // ctid fallback: a result column named "ctid" with a source table is a
        // unique physical row locator. Detect by name+type (RowDescription does
        // not reliably surface the system attnum for ctid).
        let mut ctid_col_of: HashMap<u32, u32> = HashMap::new();
        for (i, c) in prepared.columns().iter().enumerate() {
            if c.name() == "ctid" && c.type_().name() == "tid" {
                if let Some(oid) = c.table_oid() {
                    ctid_col_of.entry(oid).or_insert(i as u32);
                }
            }
        }
        // for tables without a usable PK in the result, fall back to ctid
        let mut ctid_tables: HashSet<u32> = HashSet::new();
        for (&oid, &ctid_col) in &ctid_col_of {
            if !table_names.contains_key(&oid) || pk_cols.contains_key(&oid) {
                continue;
            }
            pk_cols.insert(oid, vec![ctid_col]);
            ctid_tables.insert(oid);
        }

        let columns = prepared
            .columns()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let table_oid = c.table_oid();
                let attnum = c.column_id();
                let is_ctid = ctid_col_of.get(&table_oid.unwrap_or(0)) == Some(&(i as u32));
                let (editable, reason, warn) = if is_ctid {
                    (false, Some("ctid — physical row locator".into()), None)
                } else {
                    match (table_oid, attnum) {
                        (None, _) => (
                            false,
                            Some("computed expression — no source table".into()),
                            None,
                        ),
                        (_, None) => (false, Some("not a plain table column".into()), None),
                        (Some(oid), Some(_)) => {
                            if pk_cols.contains_key(&oid) {
                                let warn = if ctid_tables.contains(&oid) {
                                    Some("no primary key in result — editing via ctid".into())
                                } else {
                                    None
                                };
                                (true, None, warn)
                            } else if table_pks.get(&oid).is_none_or(|p| p.is_empty()) {
                                (
                                    false,
                                    Some(
                                        "no primary key — add ctid to the SELECT to edit".into(),
                                    ),
                                    None,
                                )
                            } else {
                                (
                                    false,
                                    Some(
                                        "primary key not in result — add it (or ctid) to the SELECT"
                                            .into(),
                                    ),
                                    None,
                                )
                            }
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
                    is_ctid,
                    warn,
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

    /// Group edits by (table, row) and build ONE `UPDATE … SET a=, b=, …
    /// WHERE pk RETURNING a::text, b::text` per row. Returns each planned
    /// statement plus the original edit indices in RETURNING-column order, so
    /// callers can map results back to the cells the user touched.
    async fn plan_edits(
        &self,
        sql: &str,
        statement_index: u32,
        edits: &[RowEdit],
    ) -> Result<Vec<PlannedUpdate>> {
        let map = self.editability(sql, statement_index).await?;
        let col_meta = |idx: u32| map.columns.iter().find(|c| c.col == idx).cloned();

        // group edits preserving first-seen order; key = table + pk signature
        struct Group {
            table_oid: u32,
            pk: Vec<(u32, Option<String>)>,
            /// (original edit index, edited result column, new value)
            sets: Vec<(usize, u32, Option<String>)>,
        }
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Group> = HashMap::new();
        for (ei, e) in edits.iter().enumerate() {
            // reject non-editable up front (matches old per-cell guard)
            col_meta(e.col)
                .filter(|m| m.editable && m.table_oid == e.table_oid)
                .ok_or_else(|| DriverError::Internal(format!("column {} not editable", e.col)))?;
            let mut sig = e.table_oid.to_string();
            for (c, v) in &e.pk {
                sig.push('|');
                sig.push_str(&c.to_string());
                sig.push('=');
                sig.push_str(v.as_deref().unwrap_or("\u{0}NULL"));
            }
            let g = groups.entry(sig.clone()).or_insert_with(|| {
                order.push(sig);
                Group {
                    table_oid: e.table_oid,
                    pk: e.pk.clone(),
                    sets: Vec::new(),
                }
            });
            g.sets.push((ei, e.col, e.value.clone()));
        }

        let mut planned = Vec::with_capacity(order.len());
        for sig in &order {
            let g = &groups[sig];
            let table = map
                .tables
                .get(&g.table_oid)
                .ok_or_else(|| DriverError::Internal("unknown table in edit".into()))?;

            // real column names by attnum (one pg_attribute round trip); ctid
            // is a system column with no pg_attribute row — handled inline.
            let real_attnums: Vec<i16> = g
                .sets
                .iter()
                .filter_map(|(_, c, _)| col_meta(*c).map(|m| m.attnum))
                .chain(g.pk.iter().filter_map(|(c, _)| col_meta(*c).map(|m| m.attnum)))
                .filter(|a| *a > 0)
                .collect();
            let names = self.attnames(g.table_oid, &real_attnums).await?;
            let name_of = |m: &ColumnEditMeta| -> Option<String> {
                if m.is_ctid {
                    Some("ctid".to_string())
                } else {
                    names.get(&m.attnum).cloned()
                }
            };

            let mut set_parts = Vec::new();
            let mut returning = Vec::new();
            let mut edit_indices = Vec::new();
            for (ei, c, v) in &g.sets {
                let m = col_meta(*c).unwrap();
                let n = name_of(&m)
                    .ok_or_else(|| DriverError::Internal("column name lookup failed".into()))?;
                let value_sql = match v {
                    None => "NULL".to_string(),
                    Some(s) => format!("{}::{}", ql(s), m.type_name),
                };
                set_parts.push(format!("{} = {}", qi(&n), value_sql));
                returning.push(format!("{}::text", qi(&n)));
                edit_indices.push(*ei);
            }

            let mut where_parts = Vec::new();
            for (c, v) in &g.pk {
                let m = col_meta(*c)
                    .ok_or_else(|| DriverError::Internal("bad pk column".into()))?;
                let n = name_of(&m)
                    .ok_or_else(|| DriverError::Internal("pk column name lookup failed".into()))?;
                let rhs = match v {
                    None => "IS NULL".to_string(),
                    Some(s) => format!("= {}::{}", ql(s), m.type_name),
                };
                where_parts.push(format!("{} {}", qi(&n), rhs));
            }

            planned.push(PlannedUpdate {
                sql: format!(
                    "UPDATE {} SET {} WHERE {} RETURNING {}",
                    table_path(table),
                    set_parts.join(", "),
                    where_parts.join(" AND "),
                    returning.join(", "),
                ),
                edit_indices,
            });
        }
        Ok(planned)
    }

    /// Generate the UPDATE statements for a set of edits (no execution) — for
    /// the commit-preview modal. One statement per edited row.
    pub async fn build_edit_statements(
        &self,
        sql: &str,
        statement_index: u32,
        edits: &[RowEdit],
    ) -> Result<Vec<String>> {
        Ok(self
            .plan_edits(sql, statement_index, edits)
            .await?
            .into_iter()
            .map(|p| p.sql)
            .collect())
    }

    /// Apply edits in ONE transaction. Values are text with a cast to the
    /// column's type — same semantics as typing them in psql.
    pub async fn apply_edits(
        &self,
        sql: &str,
        statement_index: u32,
        edits: Vec<RowEdit>,
    ) -> Result<EditOutcome> {
        let planned = self.plan_edits(sql, statement_index, &edits).await?;
        let mut statements = vec!["BEGIN".to_string()];
        statements.extend(planned.iter().map(|p| p.sql.clone()));
        statements.push("COMMIT".to_string());
        let batch = statements.join(";\n");

        match self.execute_simple(&batch).await {
            Ok(out) => {
                // results aligned to original edit order
                let mut results: Vec<EditResult> = (0..edits.len())
                    .map(|_| EditResult {
                        ok: false,
                        message: Some("not applied".into()),
                        new_value: None,
                    })
                    .collect();
                // out.statements: [BEGIN, update0, update1, …, COMMIT]
                for (gi, p) in planned.iter().enumerate() {
                    let stmt = out.statements.get(1 + gi);
                    let matched = stmt.map(|s| s.rows.len()).unwrap_or(0);
                    let ok = matched == 1;
                    let row = stmt.and_then(|s| s.rows.first());
                    for (ret_pos, &ei) in p.edit_indices.iter().enumerate() {
                        results[ei] = if ok {
                            EditResult {
                                ok: true,
                                message: None,
                                new_value: row.and_then(|r| r.get(ret_pos).cloned()).flatten(),
                            }
                        } else {
                            EditResult {
                                ok: false,
                                message: Some(format!("{matched} rows matched (expected 1)")),
                                new_value: None,
                            }
                        };
                    }
                }
                Ok(EditOutcome { results, committed: true })
            }
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                Err(e)
            }
        }
    }

    /// Delete rows of a single table by locator (PK or ctid). One transaction;
    /// each DELETE must match exactly one row (locators are always unique).
    pub async fn delete_rows(
        &self,
        sql: &str,
        statement_index: u32,
        table_oid: u32,
        rows: Vec<Vec<(u32, Option<String>)>>,
    ) -> Result<EditOutcome> {
        let map = self.editability(sql, statement_index).await?;
        let col_meta = |idx: u32| map.columns.iter().find(|c| c.col == idx).cloned();
        let table = map
            .tables
            .get(&table_oid)
            .ok_or_else(|| DriverError::Internal("unknown table for delete".into()))?;

        let attset: Vec<i16> = rows
            .iter()
            .flatten()
            .filter_map(|(c, _)| col_meta(*c).map(|m| m.attnum))
            .filter(|a| *a > 0)
            .collect();
        let names = self.attnames(table_oid, &attset).await?;
        let name_of = |m: &ColumnEditMeta| -> Option<String> {
            if m.is_ctid {
                Some("ctid".to_string())
            } else {
                names.get(&m.attnum).cloned()
            }
        };

        let mut statements = vec!["BEGIN".to_string()];
        for locator in &rows {
            let mut where_parts = Vec::new();
            for (c, v) in locator {
                let m = col_meta(*c)
                    .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
                let n = name_of(&m)
                    .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
                let rhs = match v {
                    None => "IS NULL".to_string(),
                    Some(s) => format!("= {}::{}", ql(s), m.type_name),
                };
                where_parts.push(format!("{} {}", qi(&n), rhs));
            }
            if where_parts.is_empty() {
                return Err(DriverError::Internal(
                    "refusing to delete with an empty row locator".into(),
                ));
            }
            statements.push(format!(
                "DELETE FROM {} WHERE {} RETURNING ctid::text",
                table_path(table),
                where_parts.join(" AND "),
            ));
        }
        statements.push("COMMIT".to_string());
        let batch = statements.join(";\n");

        match self.execute_simple(&batch).await {
            Ok(out) => {
                let mut results = Vec::with_capacity(rows.len());
                for stmt in out.statements.iter().skip(1).take(rows.len()) {
                    let matched = stmt.rows.len();
                    results.push(EditResult {
                        ok: matched == 1,
                        message: if matched == 1 {
                            None
                        } else {
                            Some(format!("{matched} rows matched (expected 1)"))
                        },
                        new_value: None,
                    });
                }
                Ok(EditOutcome {
                    results,
                    committed: true,
                })
            }
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                Err(e)
            }
        }
    }

    /// Insert one row. Columns the user left untouched are omitted so table
    /// defaults apply. Values are text literals — Postgres coerces them to the
    /// target column type on INSERT (same as typing them in psql).
    pub async fn insert_row(
        &self,
        schema: &str,
        table: &str,
        cols: Vec<String>,
        values: Vec<Option<String>>,
    ) -> Result<ExecOutcome> {
        if cols.len() != values.len() {
            return Err(DriverError::Internal(
                "insert: column/value count mismatch".into(),
            ));
        }
        let t = format!("{}.{}", qi(schema), qi(table));
        let sql = if cols.is_empty() {
            format!("INSERT INTO {t} DEFAULT VALUES RETURNING *")
        } else {
            let collist = cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
            let vallist = values
                .iter()
                .map(|v| match v {
                    None => "NULL".to_string(),
                    Some(s) => ql(s),
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {t} ({collist}) VALUES ({vallist}) RETURNING *")
        };
        self.execute_simple(&sql).await
    }

    async fn attnames(&self, table_oid: u32, attnums: &[i16]) -> Result<HashMap<i16, String>> {
        if attnums.is_empty() {
            return Ok(HashMap::new());
        }
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
