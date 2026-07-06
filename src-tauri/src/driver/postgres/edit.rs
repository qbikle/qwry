//! Editable-results pipeline. After a SELECT runs (simple protocol, text
//! values), we `prepare()` the same statement — the RowDescription gives each
//! result column's source table OID + attnum WITHOUT re-executing. Columns map
//! back to real tables; if a table's full PK is present in the result set, its
//! cells are editable and edits become `UPDATE … WHERE pk = …` in one
//! transaction, with RETURNING to refresh the grid.
//!
//! Round-trip budget (the ⌘S path used to cost ~3N+6 sequential RTTs over a
//! bastion): the frontend can pass back the mapping it already holds (the
//! EditabilityMap it fetched at result time + column names from the schema
//! snapshot), so planning needs ZERO catalog trips, and the whole commit runs
//! as ONE `BEGIN; UPDATE₁; …; UPDATEₙ` simple-query message verified from the
//! result stream, then ONE COMMIT/ROLLBACK — 2 RTTs regardless of N. A missing
//! or incomplete hint falls back to full server-side derivation. Trust model:
//! a stale hint can only produce (a) a SQL error → the whole batch rolls back,
//! or (b) a locator matching ≠ 1 row → the whole batch rolls back; the
//! frontend refreshes its map on schema-shaped errors and on observed DDL.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::splitter::split_statements;
use super::{map_pg_err, PgSession};
use crate::driver::{DriverError, ExecOutcome, Result, StatementResult};

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

/// Frontend-supplied identity of one table (from the schema snapshot) — lets
/// `editability` skip its pg_class/pg_index round trip when every OID the
/// prepared statement references is covered. Stale data self-corrects: the
/// commit path verifies matched==1 per row and rolls back on any mismatch.
#[derive(Debug, Clone, Deserialize)]
pub struct TableIdentityHint {
    pub table_oid: u32,
    /// "schema.name" exactly as the derived path renders it
    pub dotted: String,
    /// PK attnums in index order; empty = no primary key
    pub pk_attnums: Vec<i16>,
}

/// One column of a frontend-supplied edit mapping (mirror of ColumnEditMeta
/// plus the REAL column name resolved from the schema snapshot).
#[derive(Debug, Clone, Deserialize)]
pub struct ColumnMapHint {
    pub col: u32,
    pub table_oid: u32,
    pub attnum: i16,
    pub editable: bool,
    pub type_name: String,
    #[serde(default)]
    pub is_ctid: bool,
    /// real column name; None only allowed for ctid columns
    #[serde(default)]
    pub name: Option<String>,
}

/// Frontend-supplied mapping for the plan/apply/delete paths — the
/// EditabilityMap it already fetched plus attnum→name from the snapshot.
/// When present and complete, planning does zero catalog round trips.
#[derive(Debug, Clone, Deserialize)]
pub struct EditMapHint {
    pub columns: Vec<ColumnMapHint>,
    pub pk_cols: HashMap<u32, Vec<u32>>,
    pub tables: HashMap<u32, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RowEdit {
    pub table_oid: u32,
    /// result-column index being edited
    pub col: u32,
    /// new value as text; None = SET NULL
    pub value: Option<String>,
    /// SET col = DEFAULT (value is ignored)
    #[serde(default)]
    pub use_default: bool,
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

/// Fully resolved mapping the planners run on — either converted from a
/// frontend hint (zero round trips) or derived server-side (prepare +
/// pg_class + one bulk pg_attribute trip).
struct ResolvedMap {
    columns: Vec<ColumnEditMeta>,
    tables: HashMap<u32, String>,
    /// (table_oid, attnum) → real column name
    names: HashMap<(u32, i16), String>,
}

impl ResolvedMap {
    fn col_meta(&self, idx: u32) -> Option<&ColumnEditMeta> {
        self.columns.iter().find(|c| c.col == idx)
    }

    fn name_of(&self, m: &ColumnEditMeta) -> Option<String> {
        if m.is_ctid {
            Some("ctid".to_string())
        } else {
            self.names.get(&(m.table_oid, m.attnum)).cloned()
        }
    }
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

/// a usable hint has a name for every non-ctid column that maps to a real
/// table attribute, and identifies every table its pk_cols reference
fn hint_complete(h: &EditMapHint) -> bool {
    h.columns.iter().all(|c| {
        c.is_ctid || c.table_oid == 0 || c.attnum <= 0 || c.name.is_some()
    }) && h.pk_cols.keys().all(|oid| h.tables.contains_key(oid))
}

impl PgSession {
    /// Build the editability map for one statement of the last-run SQL.
    /// `tables_hint` (oid → identity from the frontend's schema snapshot) lets
    /// this complete in ONE round trip (the prepare); any OID not covered
    /// falls back to the catalog query for all of them.
    pub async fn editability(
        &self,
        sql: &str,
        statement_index: u32,
        tables_hint: Option<&[TableIdentityHint]>,
    ) -> Result<EditabilityMap> {
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
        // fast path: the snapshot hint covers every referenced OID → no catalog trip
        let hinted = tables_hint.and_then(|hints| {
            let by_oid: HashMap<u32, &TableIdentityHint> =
                hints.iter().map(|h| (h.table_oid, h)).collect();
            if oids.iter().all(|o| by_oid.contains_key(o)) {
                Some(by_oid)
            } else {
                None
            }
        });
        if let Some(by_oid) = hinted {
            for &oid in &oids {
                if let Some(h) = by_oid.get(&oid) {
                    table_names.insert(oid, h.dotted.clone());
                    table_pks.insert(oid, h.pk_attnums.clone());
                }
            }
        } else if !oids.is_empty() {
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
            let rows = out
                .statements
                .first()
                .map(|s| s.rows.as_slice())
                .unwrap_or(&[]);
            for row in rows {
                let oid: u32 = row
                    .first()
                    .and_then(|v| v.as_deref())
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0);
                table_names.insert(
                    oid,
                    row.get(1).and_then(|v| v.clone()).unwrap_or_default(),
                );
                let pks: Vec<i16> = row
                    .get(2)
                    .and_then(|v| v.as_deref())
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
                                        "no primary key — SELECT ctid, * FROM … makes rows editable".into(),
                                    ),
                                    None,
                                )
                            } else {
                                (
                                    false,
                                    Some(
                                        "primary key not in result — SELECT it, or ctid (SELECT ctid, * FROM …)"
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

    /// Resolve the mapping planners run on. With a complete frontend hint this
    /// is pure conversion (zero round trips); otherwise derive server-side:
    /// editability (prepare + pg_class) plus ONE bulk pg_attribute fetch for
    /// every referenced table (was: one trip per edited row group).
    async fn resolve_map(
        &self,
        sql: &str,
        statement_index: u32,
        hint: Option<EditMapHint>,
    ) -> Result<ResolvedMap> {
        if let Some(h) = hint {
            if hint_complete(&h) {
                let mut names = HashMap::new();
                let columns = h
                    .columns
                    .into_iter()
                    .map(|c| {
                        if let Some(n) = &c.name {
                            if c.table_oid != 0 && c.attnum > 0 {
                                names.insert((c.table_oid, c.attnum), n.clone());
                            }
                        }
                        ColumnEditMeta {
                            col: c.col,
                            table_oid: c.table_oid,
                            attnum: c.attnum,
                            editable: c.editable,
                            reason: None,
                            type_name: c.type_name,
                            is_ctid: c.is_ctid,
                            warn: None,
                        }
                    })
                    .collect();
                return Ok(ResolvedMap {
                    columns,
                    tables: h.tables,
                    names,
                });
            }
            // incomplete hint → silently fall through to full derivation
        }

        let map = self.editability(sql, statement_index, None).await?;
        // one bulk name fetch for every table the map references
        let mut names: HashMap<(u32, i16), String> = HashMap::new();
        if !map.tables.is_empty() {
            let oid_list = map
                .tables
                .keys()
                .map(|o| o.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let q = format!(
                "SELECT attrelid::int8, attnum::int2, attname FROM pg_attribute
                 WHERE attrelid IN ({oid_list}) AND attnum > 0 AND NOT attisdropped"
            );
            let out = self.execute_simple(&q).await?;
            let rows = out
                .statements
                .first()
                .map(|s| s.rows.as_slice())
                .unwrap_or(&[]);
            for row in rows {
                let oid: Option<u32> = row.first().and_then(|v| v.as_deref()).and_then(|s| s.parse().ok());
                let att: Option<i16> = row.get(1).and_then(|v| v.as_deref()).and_then(|s| s.parse().ok());
                let name = row.get(2).and_then(|v| v.clone());
                if let (Some(oid), Some(att), Some(name)) = (oid, att, name) {
                    names.insert((oid, att), name);
                }
            }
        }
        Ok(ResolvedMap {
            columns: map.columns,
            tables: map.tables,
            names,
        })
    }

    /// Generate the UPDATE statements for a set of edits (no execution) — for
    /// the commit-preview modal. One statement per edited row. With a complete
    /// `map_hint` this touches the server ZERO times, and `apply_edits` run on
    /// the same inputs generates byte-identical SQL (same function).
    pub async fn build_edit_statements(
        &self,
        sql: &str,
        statement_index: u32,
        edits: &[RowEdit],
        map_hint: Option<EditMapHint>,
    ) -> Result<Vec<String>> {
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        Ok(plan_edits(&map, edits)?
            .into_iter()
            .map(|p| p.sql)
            .collect())
    }

    /// Apply edits in ONE transaction, verify-then-commit: the whole batch is
    /// sent as a single `BEGIN; UPDATE₁; …; UPDATEₙ` simple-query message (the
    /// simple protocol executes in order on this session), each UPDATE's
    /// RETURNING row count is verified from the result stream, then COMMIT (or
    /// ROLLBACK) as the second round trip — 2 RTTs regardless of N. Any
    /// mismatch or error rolls the whole batch back: a stale ctid / duplicated
    /// PK / stale column mapping can never partially write and report success.
    /// Values are text with a cast to the column's type — psql semantics.
    pub async fn apply_edits(
        &self,
        sql: &str,
        statement_index: u32,
        edits: Vec<RowEdit>,
        map_hint: Option<EditMapHint>,
    ) -> Result<EditOutcome> {
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        let planned = plan_edits(&map, &edits)?;
        if planned.is_empty() {
            return Ok(EditOutcome { results: vec![], committed: false });
        }

        let out = self.run_verified_batch(planned.iter().map(|p| p.sql.as_str())).await?;

        let mut results: Vec<EditResult> = (0..edits.len())
            .map(|_| EditResult {
                ok: false,
                message: Some("not applied".into()),
                new_value: None,
            })
            .collect();
        let mut mismatch = false;
        for (p, stmt) in planned.iter().zip(out.iter()) {
            let matched = stmt.rows.len();
            let row = stmt.rows.first();
            if matched == 1 {
                for (ret_pos, &ei) in p.edit_indices.iter().enumerate() {
                    results[ei] = EditResult {
                        ok: true,
                        message: None,
                        new_value: row.and_then(|r| r.get(ret_pos).cloned()).flatten(),
                    };
                }
            } else {
                mismatch = true;
                for &ei in &p.edit_indices {
                    results[ei] = EditResult {
                        ok: false,
                        message: Some(format!("{matched} rows matched (expected 1)")),
                        new_value: None,
                    };
                }
            }
        }

        if mismatch {
            let _ = self.execute_simple("ROLLBACK").await;
            // nothing was applied — flip the would-have-succeeded rows too
            for r in results.iter_mut() {
                if r.ok {
                    *r = EditResult {
                        ok: false,
                        message: Some("rolled back — another row did not match exactly 1".into()),
                        new_value: None,
                    };
                }
            }
            return Ok(EditOutcome { results, committed: false });
        }
        match self.execute_simple("COMMIT").await {
            Ok(_) => Ok(EditOutcome { results, committed: true }),
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                Err(e)
            }
        }
    }

    /// Delete rows of a single table by locator (PK or ctid). Same batched
    /// verify-then-commit contract as `apply_edits`: one BEGIN+DELETEs message,
    /// every DELETE must match exactly one row or the whole batch rolls back.
    pub async fn delete_rows(
        &self,
        sql: &str,
        statement_index: u32,
        table_oid: u32,
        rows: Vec<Vec<(u32, Option<String>)>>,
        map_hint: Option<EditMapHint>,
    ) -> Result<EditOutcome> {
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        let table = map
            .tables
            .get(&table_oid)
            .ok_or_else(|| DriverError::Internal("unknown table for delete".into()))?;

        let mut deletes = Vec::with_capacity(rows.len());
        for locator in &rows {
            let mut where_parts = Vec::new();
            for (c, v) in locator {
                let m = map
                    .col_meta(*c)
                    .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
                let n = map
                    .name_of(m)
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
            deletes.push(format!(
                "DELETE FROM {} WHERE {} RETURNING ctid::text",
                table_path(table),
                where_parts.join(" AND "),
            ));
        }
        if deletes.is_empty() {
            return Ok(EditOutcome { results: vec![], committed: false });
        }

        let out = self.run_verified_batch(deletes.iter().map(|d| d.as_str())).await?;

        let mut results = Vec::with_capacity(rows.len());
        let mut mismatch = false;
        for stmt in out.iter() {
            let matched = stmt.rows.len();
            if matched != 1 {
                mismatch = true;
            }
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

        if mismatch {
            let _ = self.execute_simple("ROLLBACK").await;
            for r in results.iter_mut() {
                if r.ok {
                    *r = EditResult {
                        ok: false,
                        message: Some("rolled back — another row did not match exactly 1".into()),
                        new_value: None,
                    };
                }
            }
            return Ok(EditOutcome { results, committed: false });
        }
        match self.execute_simple("COMMIT").await {
            Ok(_) => Ok(EditOutcome { results, committed: true }),
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                Err(e)
            }
        }
    }

    /// Send `BEGIN; stmt₁; …; stmtₙ` as ONE simple-query message and return
    /// the per-statement results for stmt₁…stmtₙ (BEGIN's result stripped),
    /// leaving the transaction OPEN for the caller to COMMIT or ROLLBACK.
    /// Any error (SQL or protocol) rolls back before returning Err — the
    /// batch can never half-apply.
    async fn run_verified_batch<'a>(
        &self,
        stmts: impl Iterator<Item = &'a str>,
    ) -> Result<Vec<StatementResult>> {
        let mut batch = String::from("BEGIN");
        let mut n = 0usize;
        for s in stmts {
            batch.push_str(";\n");
            batch.push_str(s);
            n += 1;
        }
        let out: ExecOutcome = match self.execute_simple(&batch).await {
            Ok(o) => o,
            Err(e) => {
                let _ = self.execute_simple("ROLLBACK").await;
                return Err(e);
            }
        };
        // BEGIN + n statements, in order — anything else means our accounting
        // of the message stream is wrong, and verification would misattribute
        // counts to rows. Refuse and roll back.
        if out.statements.len() != n + 1 {
            let _ = self.execute_simple("ROLLBACK").await;
            return Err(DriverError::Internal(format!(
                "commit batch returned {} result sets, expected {}",
                out.statements.len(),
                n + 1
            )));
        }
        let mut stmts = out.statements;
        stmts.remove(0); // BEGIN
        Ok(stmts)
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
}

/// Group edits by (table, row) and build ONE `UPDATE … SET a=, b=, …
/// WHERE pk RETURNING a::text, b::text` per row. Pure function of the
/// resolved map — no I/O. Returns each planned statement plus the original
/// edit indices in RETURNING-column order, so callers can map results back
/// to the cells the user touched.
fn plan_edits(map: &ResolvedMap, edits: &[RowEdit]) -> Result<Vec<PlannedUpdate>> {
    // group edits preserving first-seen order; key = table + pk signature
    struct Group {
        table_oid: u32,
        pk: Vec<(u32, Option<String>)>,
        /// (original edit index, edited result column, new value, use_default)
        sets: Vec<(usize, u32, Option<String>, bool)>,
    }
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (ei, e) in edits.iter().enumerate() {
        // reject non-editable up front (matches old per-cell guard)
        map.col_meta(e.col)
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
        g.sets.push((ei, e.col, e.value.clone(), e.use_default));
    }

    let mut planned = Vec::with_capacity(order.len());
    for sig in &order {
        let g = &groups[sig];
        let table = map
            .tables
            .get(&g.table_oid)
            .ok_or_else(|| DriverError::Internal("unknown table in edit".into()))?;

        let mut set_parts = Vec::new();
        let mut returning = Vec::new();
        let mut edit_indices = Vec::new();
        for (ei, c, v, use_default) in &g.sets {
            let m = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("edited column not in map".into()))?;
            let n = map
                .name_of(m)
                .ok_or_else(|| DriverError::Internal("column name lookup failed".into()))?;
            let value_sql = if *use_default {
                "DEFAULT".to_string()
            } else {
                match v {
                    None => "NULL".to_string(),
                    Some(s) => format!("{}::{}", ql(s), m.type_name),
                }
            };
            set_parts.push(format!("{} = {}", qi(&n), value_sql));
            returning.push(format!("{}::text", qi(&n)));
            edit_indices.push(*ei);
        }

        let mut where_parts = Vec::new();
        for (c, v) in &g.pk {
            let m = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("bad pk column".into()))?;
            let n = map
                .name_of(m)
                .ok_or_else(|| DriverError::Internal("pk column name lookup failed".into()))?;
            let rhs = match v {
                None => "IS NULL".to_string(),
                Some(s) => format!("= {}::{}", ql(s), m.type_name),
            };
            where_parts.push(format!("{} {}", qi(&n), rhs));
        }
        if where_parts.is_empty() {
            return Err(DriverError::Internal(
                "refusing to update with an empty row locator".into(),
            ));
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
