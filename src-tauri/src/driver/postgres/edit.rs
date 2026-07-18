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
//!
//! Transaction safety: when the session already sits inside the USER's open
//! transaction, the batch is wrapped in SAVEPOINT/RELEASE instead of
//! BEGIN/COMMIT — the user's transaction is never committed or rolled back by
//! an edit. The verified-batch contract is identical in both modes.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tokio_postgres::types::Type;

use super::splitter::split_statements;
use super::{map_pg_err, PgSession};
use crate::driver::{DriverError, ExecOutcome, Result, StatementResult, TxState};

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
    /// SQL-safe cast target (quoted/schema-qualified when needed) — what the
    /// generated `::cast` uses; `type_name` stays the bare display name
    pub cast: String,
    /// this result column is the table's `ctid` (used as a row locator)
    pub is_ctid: bool,
    /// soft warning shown on an editable cell (e.g. "editing via ctid")
    pub warn: Option<String>,
}

/// schema + relation name carried SEPARATELY end-to-end — a name containing a
/// literal dot must never be reassembled by splitting a dotted string
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableRef {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditabilityMap {
    pub statement_index: u32,
    pub columns: Vec<ColumnEditMeta>,
    /// per source table_oid: which result columns hold its full PK
    pub pk_cols: HashMap<u32, Vec<u32>>,
    /// table_oid → "schema.name" (display only — SQL generation uses table_refs)
    pub tables: HashMap<u32, String>,
    /// table_oid → separate schema/name identity
    pub table_refs: HashMap<u32, TableRef>,
}

/// Frontend-supplied identity of one table (from the schema snapshot) — lets
/// `editability` skip its pg_class/pg_index round trip when every OID the
/// prepared statement references is covered. Stale data self-corrects: the
/// commit path verifies matched==1 per row and rolls back on any mismatch.
#[derive(Debug, Clone, Deserialize)]
pub struct TableIdentityHint {
    pub table_oid: u32,
    pub schema: String,
    pub name: String,
    /// PK attnums in index order; empty = no primary key
    pub pk_attnums: Vec<i16>,
    /// pg_class.relkind (r/v/m/p/f)
    #[serde(default = "default_relkind")]
    pub relkind: String,
    /// attnums with attgenerated ≠ '' (GENERATED ALWAYS AS … columns)
    #[serde(default)]
    pub generated_attnums: Vec<i16>,
    /// attnums with attidentity = 'a' (GENERATED ALWAYS AS IDENTITY)
    #[serde(default)]
    pub identity_always_attnums: Vec<i16>,
}

fn default_relkind() -> String {
    "r".into()
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
    /// SQL-safe cast target from the map; absent → conservatively re-derived
    #[serde(default)]
    pub cast: Option<String>,
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
    pub table_refs: HashMap<u32, TableRef>,
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
    /// extra old-value predicates ANDed into the WHERE — the ctid guard: rows
    /// move under UPDATE/VACUUM FULL, so a ctid locator alone could write a
    /// different row; old values pin the identity (mismatch → 0 rows → rollback)
    #[serde(default)]
    pub guard: Vec<(u32, Option<String>)>,
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
    tables: HashMap<u32, TableRef>,
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

fn table_path(t: &TableRef) -> String {
    format!("{}.{}", qi(&t.schema), qi(&t.name))
}

/// a bare lowercase identifier is safe unquoted in a cast; `"char"` is the
/// one pg_catalog name that MUST stay quoted (unquoted `char` means bpchar)
fn safe_type_ident(name: &str) -> bool {
    name != "char"
        && !name.is_empty()
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// cast target for a prepared column's type: pg_catalog types by bare name,
/// everything else quoted + schema-qualified
fn cast_of_type(ty: &Type) -> String {
    let name = ty.name();
    if ty.schema() == "pg_catalog" {
        if safe_type_ident(name) {
            name.to_string()
        } else {
            qi(name)
        }
    } else {
        format!("{}.{}", qi(ty.schema()), qi(name))
    }
}

/// conservative cast for a hint that predates the `cast` field
fn cast_fallback(type_name: &str) -> String {
    if safe_type_ident(type_name) {
        type_name.to_string()
    } else {
        qi(type_name)
    }
}

/// types with no (or no stable) `=` operator — compared via ::text instead
fn stable_equality(type_name: &str) -> bool {
    let base = type_name.strip_prefix('_').unwrap_or(type_name);
    !matches!(
        base,
        "json" | "xml" | "point" | "line" | "lseg" | "box" | "path" | "polygon" | "circle"
    )
}

/// NULL-safe equality predicate on one column: `IS NULL` for a NULL old value,
/// indexable `=` otherwise; ::text comparison for types without equality
fn eq_pred(name: &str, m: &ColumnEditMeta, v: &Option<String>) -> String {
    match v {
        None => format!("{} IS NULL", qi(name)),
        Some(s) if stable_equality(&m.type_name) => {
            format!("{} = {}::{}", qi(name), ql(s), m.cast)
        }
        Some(s) => format!("{}::text = {}", qi(name), ql(s)),
    }
}

/// a usable hint has a name for every non-ctid column that maps to a real
/// table attribute, and identifies every table its pk_cols reference
fn hint_complete(h: &EditMapHint) -> bool {
    h.columns.iter().all(|c| {
        c.is_ctid || c.table_oid == 0 || c.attnum <= 0 || c.name.is_some()
    }) && h.pk_cols.keys().all(|oid| h.table_refs.contains_key(oid))
}

/// per-table catalog facts the editability derivation runs on
struct TableFacts {
    r: TableRef,
    relkind: String,
    pks: Vec<i16>,
    generated: HashSet<i16>,
    identity_always: HashSet<i16>,
}

const EDIT_SAVEPOINT: &str = "qwry_edit_sp";

/// how the verified batch is transaction-wrapped
enum BatchTx {
    /// session was idle — our own BEGIN…COMMIT
    Own,
    /// inside the user's open transaction — SAVEPOINT/RELEASE, NEVER commit
    Savepoint,
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

        let prepared = self.client.prepare(stmt_sql).await.map_err(|e| {
            // a failed prepare inside an explicit tx aborts it
            self.note_error_outcome();
            map_pg_err(e)
        })?;

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

        let mut facts: HashMap<u32, TableFacts> = HashMap::new();
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
                    facts.insert(
                        oid,
                        TableFacts {
                            r: TableRef { schema: h.schema.clone(), name: h.name.clone() },
                            relkind: h.relkind.clone(),
                            pks: h.pk_attnums.clone(),
                            generated: h.generated_attnums.iter().copied().collect(),
                            identity_always: h.identity_always_attnums.iter().copied().collect(),
                        },
                    );
                }
            }
        } else if !oids.is_empty() {
            let oid_list = oids
                .iter()
                .map(|o| o.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let q = format!(
                "SELECT c.oid::int8, n.nspname, c.relname, c.relkind::text,
                        coalesce((SELECT array_to_string(i.indkey::int2[], ',')
                                  FROM pg_index i
                                  WHERE i.indrelid = c.oid AND i.indisprimary), ''),
                        coalesce((SELECT array_to_string(array_agg(a.attnum), ',')
                                  FROM pg_attribute a
                                  WHERE a.attrelid = c.oid AND a.attnum > 0
                                    AND NOT a.attisdropped AND a.attgenerated <> ''), ''),
                        coalesce((SELECT array_to_string(array_agg(a.attnum), ',')
                                  FROM pg_attribute a
                                  WHERE a.attrelid = c.oid AND a.attnum > 0
                                    AND NOT a.attisdropped AND a.attidentity = 'a'), '')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.oid IN ({oid_list})"
            );
            let out = self.execute_simple(&q).await?;
            let rows = out
                .statements
                .first()
                .map(|s| s.rows.as_slice())
                .unwrap_or(&[]);
            let attnums = |cell: Option<&Option<String>>| -> Vec<i16> {
                cell.and_then(|v| v.as_deref())
                    .unwrap_or("")
                    .split(',')
                    .filter_map(|s| s.trim().parse().ok())
                    .collect()
            };
            for row in rows {
                let oid: u32 = row
                    .first()
                    .and_then(|v| v.as_deref())
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0);
                facts.insert(
                    oid,
                    TableFacts {
                        r: TableRef {
                            schema: row.get(1).and_then(|v| v.clone()).unwrap_or_default(),
                            name: row.get(2).and_then(|v| v.clone()).unwrap_or_default(),
                        },
                        relkind: row.get(3).and_then(|v| v.clone()).unwrap_or_else(|| "r".into()),
                        pks: attnums(row.get(4)),
                        generated: attnums(row.get(5)).into_iter().collect(),
                        identity_always: attnums(row.get(6)).into_iter().collect(),
                    },
                );
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
        for (&oid, f) in &facts {
            if f.pks.is_empty() {
                continue;
            }
            let cols: Vec<u32> = f
                .pks
                .iter()
                .filter_map(|att| have.get(&(oid, *att)).copied())
                .collect();
            if cols.len() == f.pks.len() {
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
        // for plain tables without a usable PK in the result, fall back to
        // ctid. Only relkind 'r': a matview/view rejects writes anyway, and a
        // partitioned parent's ctid is not unique across partitions.
        let mut ctid_tables: HashSet<u32> = HashSet::new();
        for (&oid, &ctid_col) in &ctid_col_of {
            let plain = facts.get(&oid).map(|f| f.relkind == "r").unwrap_or(false);
            if !plain || pk_cols.contains_key(&oid) {
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
                        (Some(oid), Some(att)) => {
                            let f = facts.get(&oid);
                            if let Some(f) = f {
                                if f.generated.contains(&att) {
                                    (
                                        false,
                                        Some("generated column — computed by the database".into()),
                                        None,
                                    )
                                } else if f.identity_always.contains(&att) {
                                    (
                                        false,
                                        Some(
                                            "identity column (GENERATED ALWAYS) — value comes from its sequence"
                                                .into(),
                                        ),
                                        None,
                                    )
                                } else if pk_cols.contains_key(&oid) {
                                    let warn = if ctid_tables.contains(&oid) {
                                        Some("no primary key in result — editing via ctid".into())
                                    } else {
                                        None
                                    };
                                    (true, None, warn)
                                } else {
                                    (false, Some(readonly_reason(f)), None)
                                }
                            } else {
                                (false, Some("not editable — unknown source table".into()), None)
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
                    cast: cast_of_type(c.type_()),
                    is_ctid,
                    warn,
                }
            })
            .collect();

        let mut tables = HashMap::new();
        let mut table_refs = HashMap::new();
        for (oid, f) in facts {
            tables.insert(oid, format!("{}.{}", f.r.schema, f.r.name));
            table_refs.insert(oid, f.r);
        }

        Ok(EditabilityMap {
            statement_index,
            columns,
            pk_cols,
            tables,
            table_refs,
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
                        let cast = c
                            .cast
                            .unwrap_or_else(|| cast_fallback(&c.type_name));
                        ColumnEditMeta {
                            col: c.col,
                            table_oid: c.table_oid,
                            attnum: c.attnum,
                            editable: c.editable,
                            reason: None,
                            type_name: c.type_name,
                            cast,
                            is_ctid: c.is_ctid,
                            warn: None,
                        }
                    })
                    .collect();
                return Ok(ResolvedMap {
                    columns,
                    tables: h.table_refs,
                    names,
                });
            }
            // incomplete hint → silently fall through to full derivation
        }

        let map = self.editability(sql, statement_index, None).await?;
        // one bulk name fetch for every table the map references
        let mut names: HashMap<(u32, i16), String> = HashMap::new();
        if !map.table_refs.is_empty() {
            let oid_list = map
                .table_refs
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
            tables: map.table_refs,
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
    /// Inside the user's open transaction the wrapper is SAVEPOINT/RELEASE.
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

        let (out, mode) = self
            .run_verified_batch(planned.iter().map(|p| p.sql.as_str()))
            .await?;

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
            self.undo_batch(&mode).await;
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
        match self.finish_batch(&mode).await {
            Ok(()) => Ok(EditOutcome { results, committed: true }),
            Err(e) => {
                self.undo_batch(&mode).await;
                Err(e)
            }
        }
    }

    /// Delete rows of a single table by locator (PK or ctid, plus any extra
    /// old-value guard pairs). Same batched verify-then-commit contract as
    /// `apply_edits`: one wrapped batch, every DELETE must match exactly one
    /// row or the whole batch rolls back.
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
                where_parts.push(eq_pred(&n, m, v));
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

        let (out, mode) = self
            .run_verified_batch(deletes.iter().map(|d| d.as_str()))
            .await?;

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
            self.undo_batch(&mode).await;
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
        match self.finish_batch(&mode).await {
            Ok(()) => Ok(EditOutcome { results, committed: true }),
            Err(e) => {
                self.undo_batch(&mode).await;
                Err(e)
            }
        }
    }

    /// Fetch one full (untruncated) cell as text by table identity + row
    /// locator. Server-side SQL generation with real column names (aliases in
    /// the result don't leak into the WHERE) and proper ident quoting.
    pub async fn fetch_cell(
        &self,
        sql: &str,
        statement_index: u32,
        col: u32,
        locator: Vec<(u32, Option<String>)>,
        map_hint: Option<EditMapHint>,
    ) -> Result<Option<String>> {
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        let m = map
            .col_meta(col)
            .ok_or_else(|| DriverError::Internal("cell column not in map".into()))?;
        let table = map
            .tables
            .get(&m.table_oid)
            .ok_or_else(|| DriverError::Internal("unknown table for cell fetch".into()))?;
        let name = map
            .name_of(m)
            .ok_or_else(|| DriverError::Internal("cell column name lookup failed".into()))?;
        if locator.is_empty() {
            return Err(DriverError::Internal(
                "refusing to fetch a cell with an empty row locator".into(),
            ));
        }
        let mut where_parts = Vec::with_capacity(locator.len());
        for (c, v) in &locator {
            let lm = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
            let ln = map
                .name_of(lm)
                .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
            where_parts.push(eq_pred(&ln, lm, v));
        }
        let q = format!(
            "SELECT {}::text FROM {} WHERE {} LIMIT 2",
            qi(&name),
            table_path(table),
            where_parts.join(" AND "),
        );
        let out = self.execute_simple(&q).await?;
        let rows = out
            .statements
            .first()
            .map(|s| s.rows.as_slice())
            .unwrap_or(&[]);
        if rows.len() != 1 {
            return Err(DriverError::Internal(format!(
                "cell fetch matched {} rows (expected 1)",
                rows.len()
            )));
        }
        Ok(rows[0].first().cloned().flatten())
    }

    /// Send `<wrapper>; stmt₁; …; stmtₙ` as ONE simple-query message and return
    /// the per-statement results for stmt₁…stmtₙ (the wrapper's result
    /// stripped), leaving the batch OPEN for the caller to finish or undo.
    /// Idle session → wrapper is BEGIN (finish=COMMIT, undo=ROLLBACK); inside
    /// the user's transaction → SAVEPOINT (finish=RELEASE, undo=ROLLBACK TO +
    /// RELEASE) so the outer transaction is NEVER committed or rolled back.
    /// Any error (SQL or protocol) undoes the batch before returning Err —
    /// it can never half-apply.
    async fn run_verified_batch<'a>(
        &self,
        stmts: impl Iterator<Item = &'a str>,
    ) -> Result<(Vec<StatementResult>, BatchTx)> {
        let mode = if self.tx_state() == TxState::Idle {
            BatchTx::Own
        } else {
            BatchTx::Savepoint
        };
        let mut batch = match mode {
            BatchTx::Own => String::from("BEGIN"),
            BatchTx::Savepoint => format!("SAVEPOINT {EDIT_SAVEPOINT}"),
        };
        let mut n = 0usize;
        for s in stmts {
            batch.push_str(";\n");
            batch.push_str(s);
            n += 1;
        }
        let out: ExecOutcome = match self.execute_simple(&batch).await {
            Ok(o) => o,
            Err(e) => {
                self.undo_batch(&mode).await;
                return Err(e);
            }
        };
        // wrapper + n statements, in order — anything else means our
        // accounting of the message stream is wrong, and verification would
        // misattribute counts to rows. Refuse and undo.
        if out.statements.len() != n + 1 {
            self.undo_batch(&mode).await;
            return Err(DriverError::Internal(format!(
                "commit batch returned {} result sets, expected {}",
                out.statements.len(),
                n + 1
            )));
        }
        let mut stmts = out.statements;
        stmts.remove(0);
        Ok((stmts, mode))
    }

    /// best-effort: revert everything the batch did (and only the batch)
    async fn undo_batch(&self, mode: &BatchTx) {
        let sql = match mode {
            BatchTx::Own => "ROLLBACK".to_string(),
            BatchTx::Savepoint => format!(
                "ROLLBACK TO SAVEPOINT {EDIT_SAVEPOINT}; RELEASE SAVEPOINT {EDIT_SAVEPOINT}"
            ),
        };
        let _ = self.execute_simple(&sql).await;
    }

    /// make the batch durable (Own: COMMIT) or fold it into the user's open
    /// transaction (Savepoint: RELEASE — their COMMIT decides durability)
    async fn finish_batch(&self, mode: &BatchTx) -> Result<()> {
        let sql = match mode {
            BatchTx::Own => "COMMIT".to_string(),
            BatchTx::Savepoint => format!("RELEASE SAVEPOINT {EDIT_SAVEPOINT}"),
        };
        self.execute_simple(&sql).await.map(|_| ())
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

/// honest per-relkind reason when a table has no usable row locator in the result
fn readonly_reason(f: &TableFacts) -> String {
    match f.relkind.as_str() {
        "v" => "view — not editable directly; edit its base table".into(),
        "m" => "materialized view — read-only (REFRESH MATERIALIZED VIEW updates it)".into(),
        "f" => "foreign table — editing isn't supported".into(),
        "p" => {
            if f.pks.is_empty() {
                "partitioned table with no primary key — add one to edit (ctid is not unique across partitions)".into()
            } else {
                "primary key not in result — SELECT it to edit".into()
            }
        }
        "r" => {
            if f.pks.is_empty() {
                "no primary key — SELECT ctid, * FROM … makes rows editable".into()
            } else {
                "primary key not in result — SELECT it, or ctid (SELECT ctid, * FROM …)".into()
            }
        }
        _ => "not editable".into(),
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
        guard: Vec<(u32, Option<String>)>,
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
                guard: e.guard.clone(),
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
                    Some(s) => format!("{}::{}", ql(s), m.cast),
                }
            };
            set_parts.push(format!("{} = {}", qi(&n), value_sql));
            returning.push(format!("{}::text", qi(&n)));
            edit_indices.push(*ei);
        }

        let mut where_parts = Vec::new();
        let mut seen_where: HashSet<u32> = HashSet::new();
        for (c, v) in g.pk.iter().chain(g.guard.iter()) {
            if !seen_where.insert(*c) {
                continue;
            }
            let m = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
            let n = map
                .name_of(m)
                .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
            where_parts.push(eq_pred(&n, m, v));
        }
        if g.pk.is_empty() || where_parts.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(col: u32, oid: u32, attnum: i16, type_name: &str, cast: &str, is_ctid: bool) -> ColumnEditMeta {
        ColumnEditMeta {
            col,
            table_oid: oid,
            attnum,
            editable: !is_ctid,
            reason: None,
            type_name: type_name.into(),
            cast: cast.into(),
            is_ctid,
            warn: None,
        }
    }

    fn test_map() -> ResolvedMap {
        let mut tables = HashMap::new();
        tables.insert(
            7u32,
            TableRef { schema: "sch.dot".into(), name: "ta.ble".into() },
        );
        let mut names = HashMap::new();
        names.insert((7u32, 1i16), "id".to_string());
        names.insert((7u32, 2i16), "Name".to_string());
        names.insert((7u32, 3i16), "doc".to_string());
        ResolvedMap {
            columns: vec![
                meta(0, 7, 1, "int4", "int4", false),
                meta(1, 7, 2, "mystatus", "\"public\".\"MyStatus\"", false),
                meta(2, 7, 3, "json", "json", false),
                meta(3, 7, 0, "tid", "tid", true),
            ],
            tables,
            names,
        }
    }

    #[test]
    fn dotted_names_quote_separately() {
        let map = test_map();
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 0,
            value: Some("5".into()),
            use_default: false,
            pk: vec![(0, Some("1".into()))],
            guard: vec![],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        assert!(
            planned[0].sql.starts_with(r#"UPDATE "sch.dot"."ta.ble" SET"#),
            "{}",
            planned[0].sql
        );
    }

    #[test]
    fn cast_is_taken_from_map_not_type_name() {
        let map = test_map();
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 1,
            value: Some("active".into()),
            use_default: false,
            pk: vec![(0, Some("1".into()))],
            guard: vec![],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        assert!(
            planned[0].sql.contains(r#""Name" = 'active'::"public"."MyStatus""#),
            "{}",
            planned[0].sql
        );
    }

    #[test]
    fn guards_pin_old_values() {
        let map = test_map();
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 0,
            value: Some("5".into()),
            use_default: false,
            pk: vec![(3, Some("(0,1)".into()))],
            guard: vec![
                (0, Some("4".into())),
                (1, None),
                (2, Some("{\"k\":1}".into())),
            ],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        let sql = &planned[0].sql;
        assert!(sql.contains(r#""ctid" = '(0,1)'::tid"#), "{sql}");
        assert!(sql.contains(r#""id" = '4'::int4"#), "{sql}");
        assert!(sql.contains(r#""Name" IS NULL"#), "{sql}");
        // json has no equality operator — compared via ::text
        assert!(sql.contains(r#""doc"::text = '{"k":1}'"#), "{sql}");
    }

    #[test]
    fn guard_dedupes_against_pk() {
        let map = test_map();
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 1,
            value: Some("x".into()),
            use_default: false,
            pk: vec![(0, Some("1".into()))],
            guard: vec![(0, Some("1".into())), (1, Some("old".into()))],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        let sql = &planned[0].sql;
        assert_eq!(sql.matches(r#""id" ="#).count(), 1, "{sql}");
    }

    #[test]
    fn cast_helpers() {
        assert_eq!(cast_fallback("int4"), "int4");
        assert_eq!(cast_fallback("MyType"), "\"MyType\"");
        assert_eq!(cast_fallback("char"), "\"char\"");
        assert!(!stable_equality("json"));
        assert!(!stable_equality("_json"));
        assert!(!stable_equality("point"));
        assert!(stable_equality("jsonb"));
        assert!(stable_equality("int4"));
        assert!(stable_equality("_int4"));
    }
}
