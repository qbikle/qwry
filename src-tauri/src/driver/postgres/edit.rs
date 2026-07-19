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
//!
//! Inverse-SQL undo: every UPDATE captures the row's OLD values inside the
//! same statement (`UPDATE t AS __t SET … FROM (SELECT <changed cols> FROM t
//! WHERE <locator+guards> FOR UPDATE) AS __old WHERE <locator+guards on __t>
//! RETURNING __old.<changed>, __t.<changed>, __t.<locator>`), and every DELETE
//! captures the whole row via `RETURNING *` — zero extra round trips. The
//! FOR UPDATE lock makes the captured old values the exact pre-update tuple
//! (a concurrent writer can't slip between capture and write). A committed
//! batch yields a structured `UndoPlan` (never parsed SQL) that regenerates
//! its revert statements through THIS generator and re-enters the same
//! verified pipeline: a stale undo (data changed since) matches ≠ 1 and rolls
//! back honestly. Applying an undo captures again, so redo emerges naturally.
//! PG 14-17 grammar only — PG 18's OLD/NEW RETURNING is deliberately unused.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

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
    /// revert plan for a committed batch — consumed by the undo-log write in
    /// commands.rs, never serialized to the frontend
    #[serde(skip)]
    pub revert: Option<UndoPlan>,
}

/// One planned UPDATE (one edited row) plus the original edit indices in the
/// same order as its SET columns, plus the capture metadata the revert plan
/// is built from. RETURNING layout (see `build_capture_update`): old values
/// at 0..n, new values at n..2n, post-update locator after that.
struct PlannedUpdate {
    sql: String,
    edit_indices: Vec<usize>,
    meta: CaptureMeta,
}

/// Fully resolved mapping the planners run on — either converted from a
/// frontend hint (zero round trips) or derived server-side (prepare +
/// pg_class + one bulk pg_attribute trip).
struct ResolvedMap {
    columns: Vec<ColumnEditMeta>,
    tables: HashMap<u32, TableRef>,
    /// (table_oid, attnum) → real column name
    names: HashMap<(u32, i16), String>,
    /// names came from a frontend hint (snapshot-donated) — generated SQL
    /// must carry attname-verification predicates (see `NameGuards`)
    hinted: bool,
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

/// cast target for a type by schema+name: pg_catalog types by bare name,
/// everything else quoted + schema-qualified
fn cast_of_parts(schema: &str, name: &str) -> String {
    if schema == "pg_catalog" {
        if safe_type_ident(name) {
            name.to_string()
        } else {
            qi(name)
        }
    } else {
        format!("{}.{}", qi(schema), qi(name))
    }
}

fn cast_of_type(ty: &Type) -> String {
    cast_of_parts(ty.schema(), ty.name())
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
/// indexable `=` otherwise; ::text comparison for types without equality.
/// `qual` prefixes the column with a table alias (the capture grammar's outer
/// WHERE must qualify — the FROM subselect exposes the same column names).
fn eq_pred_parts(
    qual: Option<&str>,
    name: &str,
    type_name: &str,
    cast: &str,
    v: &Option<String>,
) -> String {
    let col = match qual {
        Some(q) => format!("{q}.{}", qi(name)),
        None => qi(name),
    };
    match v {
        None => format!("{col} IS NULL"),
        Some(s) if stable_equality(type_name) => format!("{col} = {}::{}", ql(s), cast),
        Some(s) => format!("{col}::text = {}", ql(s)),
    }
}

fn eq_pred(name: &str, m: &ColumnEditMeta, v: &Option<String>) -> String {
    eq_pred_parts(None, name, &m.type_name, &m.cast, v)
}

// ---- inverse-SQL undo plan ------------------------------------------------

/// One column's identity (+ value) as carried in revert plans and the shared
/// SQL builders. `use_default` is meaningful only in SET lists (commit path);
/// revert SETs always restore explicit captured values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoCol {
    pub name: String,
    pub type_name: String,
    pub cast: String,
    pub value: Option<String>,
    #[serde(default)]
    pub use_default: bool,
}

/// Everything one capture-form UPDATE needs: what it sets, how it locates the
/// row, which current values pin the row's identity, and the attname identity
/// guards. `plan_edits` builds one per planned UPDATE; `UndoStmt::Update`
/// persists the same shape, so commit and undo share one generator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureMeta {
    pub table: TableRef,
    pub sets: Vec<UndoCol>,
    pub locator: Vec<UndoCol>,
    pub guards: Vec<UndoCol>,
    /// (table_oid, attnum, expected attname) — ANDed into the WHERE so an
    /// external RENAME+ADD between commit and undo matches 0, never hijacks
    pub name_guards: Vec<(u32, i16, String)>,
}

/// One statement of a persisted revert plan. Update ↔ Update and
/// Insert ↔ Delete are inverse pairs: applying a statement captures enough to
/// build its own inverse, which is how undo-of-undo (redo) emerges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoStmt {
    Update(CaptureMeta),
    /// re-create a deleted row. `skip` = GENERATED / identity-ALWAYS column
    /// names excluded from the INSERT (OVERRIDING SYSTEM VALUE deliberately
    /// not used — an identity-ALWAYS column gets a fresh value; honesty over
    /// magic). `cols` carries EVERY captured column with type identity.
    Insert {
        table: TableRef,
        cols: Vec<UndoCol>,
        skip: Vec<String>,
    },
    /// re-delete a re-inserted row (redo of a delete): located by the ctid
    /// captured from the INSERT, pinned by every non-skip column value.
    Delete {
        table: TableRef,
        locator: Vec<UndoCol>,
        guards: Vec<UndoCol>,
        /// full column identity list — the next inverse INSERT rebuilds from
        /// this (values refreshed from the DELETE's RETURNING *)
        cols: Vec<UndoCol>,
        skip: Vec<String>,
    },
}

/// A committed batch's revert plan — the persisted undo artifact (stored as
/// JSON in appdb `undo_log.revert_sql`; SQL is regenerated from it at undo
/// time by the same generator that built the commit).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoPlan {
    pub stmts: Vec<UndoStmt>,
    pub description: String,
}

/// outcome of applying a revert plan (mirrored in src/ipc/types.ts)
#[derive(Debug, Clone, Serialize)]
pub struct UndoOutcome {
    pub committed: bool,
    pub message: Option<String>,
}

const UPD_TARGET_ALIAS: &str = "__t";
const UPD_OLD_ALIAS: &str = "__old";

/// WHERE predicates for locator + guards, deduped by column name (a guard
/// repeating a locator column must not appear twice)
fn where_preds(locator: &[UndoCol], guards: &[UndoCol], qual: Option<&str>) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut parts = Vec::new();
    for c in locator.iter().chain(guards.iter()) {
        if !seen.insert(c.name.as_str()) {
            continue;
        }
        parts.push(eq_pred_parts(qual, &c.name, &c.type_name, &c.cast, &c.value));
    }
    parts
}

fn name_guard_preds(name_guards: &[(u32, i16, String)]) -> impl Iterator<Item = String> + '_ {
    name_guards.iter().map(|(oid, att, name)| {
        format!(
            "(SELECT attname FROM pg_attribute WHERE attrelid = {oid} AND attnum = {att}) = {}",
            ql(name)
        )
    })
}

/// The capture-form UPDATE. One result set, RETURNING one row per updated
/// target row — matched==1 verification is unchanged from the plain grammar:
/// the FROM subselect and the outer WHERE carry the IDENTICAL predicate set,
/// so for the only committing case (locator matches exactly one row) both
/// sides are the same single row and the join multiplies nothing; an empty
/// subselect (guards failed) updates zero rows. RETURNING layout:
/// `__old.<sets>` (old values) · `__t.<sets>` (new values) · `__t.<locator>`
/// (post-update locator — the NEW ctid after row movement).
/// `include_name_guards`: attname identity probes ride the inner WHERE only
/// (they are row-independent gates; doubling them adds nothing to counting).
fn build_capture_update(meta: &CaptureMeta, include_name_guards: bool) -> String {
    let t = table_path(&meta.table);
    let set_parts: Vec<String> = meta
        .sets
        .iter()
        .map(|c| {
            let v = if c.use_default {
                "DEFAULT".to_string()
            } else {
                match &c.value {
                    None => "NULL".to_string(),
                    Some(s) => format!("{}::{}", ql(s), c.cast),
                }
            };
            format!("{} = {}", qi(&c.name), v)
        })
        .collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let sel_cols: Vec<String> = meta
        .sets
        .iter()
        .filter(|c| seen.insert(c.name.as_str()))
        .map(|c| qi(&c.name))
        .collect();
    let mut inner_where = where_preds(&meta.locator, &meta.guards, None);
    if include_name_guards {
        inner_where.extend(name_guard_preds(&meta.name_guards));
    }
    let outer_where = where_preds(&meta.locator, &meta.guards, Some(UPD_TARGET_ALIAS));
    let mut returning: Vec<String> = Vec::new();
    for c in &meta.sets {
        returning.push(format!("{UPD_OLD_ALIAS}.{}::text", qi(&c.name)));
    }
    for c in &meta.sets {
        returning.push(format!("{UPD_TARGET_ALIAS}.{}::text", qi(&c.name)));
    }
    for c in &meta.locator {
        returning.push(format!("{UPD_TARGET_ALIAS}.{}::text", qi(&c.name)));
    }
    format!(
        "UPDATE {t} AS {UPD_TARGET_ALIAS} SET {} FROM (SELECT {} FROM {t} WHERE {} FOR UPDATE) AS {UPD_OLD_ALIAS} WHERE {} RETURNING {}",
        set_parts.join(", "),
        sel_cols.join(", "),
        inner_where.join(" AND "),
        outer_where.join(" AND "),
        returning.join(", "),
    )
}

/// Build the inverse of an applied capture-form UPDATE from its RETURNING
/// row. Used at commit time (revert = restore old values) AND at undo time
/// (redo = restore the undone values) — perfectly symmetric. Returns None if
/// the row doesn't hold the expected capture layout (accounting drift —
/// refuse a revert rather than persist a wrong one).
fn inverse_of_update(meta: &CaptureMeta, row: &[Option<String>]) -> Option<UndoStmt> {
    let n = meta.sets.len();
    if row.len() < 2 * n + meta.locator.len() {
        return None;
    }
    let old_vals = &row[0..n];
    let new_vals = &row[n..2 * n];
    let loc_vals = &row[2 * n..2 * n + meta.locator.len()];
    let with_value = |c: &UndoCol, v: &Option<String>| UndoCol {
        name: c.name.clone(),
        type_name: c.type_name.clone(),
        cast: c.cast.clone(),
        value: v.clone(),
        use_default: false,
    };
    let sets: Vec<UndoCol> = meta.sets.iter().zip(old_vals).map(|(c, v)| with_value(c, v)).collect();
    let locator: Vec<UndoCol> = meta
        .locator
        .iter()
        .zip(loc_vals)
        .map(|(c, v)| with_value(c, v))
        .collect();
    let set_names: HashSet<&str> = meta.sets.iter().map(|c| c.name.as_str()).collect();
    let loc_names: HashSet<&str> = meta.locator.iter().map(|c| c.name.as_str()).collect();
    // pins for the revert: the values we just wrote (server-normalized wire
    // text from RETURNING, not our input literals — '1.50'::numeric etc.)
    // plus every original guard column we did NOT touch, at its old value
    let mut guards: Vec<UndoCol> = meta
        .sets
        .iter()
        .zip(new_vals)
        .filter(|(c, _)| !loc_names.contains(c.name.as_str()))
        .map(|(c, v)| with_value(c, v))
        .collect();
    guards.extend(
        meta.guards
            .iter()
            .filter(|c| !set_names.contains(c.name.as_str()) && !loc_names.contains(c.name.as_str()))
            .cloned(),
    );
    Some(UndoStmt::Update(CaptureMeta {
        table: meta.table.clone(),
        sets,
        locator,
        guards,
        name_guards: meta.name_guards.clone(),
    }))
}

/// SQL for one revert-plan statement (regenerated, never parsed). Every
/// statement carries a RETURNING and must match exactly 1 row.
fn revert_stmt_sql(stmt: &UndoStmt) -> String {
    match stmt {
        // persisted name guards are deliberate — always include them
        UndoStmt::Update(meta) => build_capture_update(meta, true),
        UndoStmt::Insert { table, cols, skip } => {
            let insertable: Vec<&UndoCol> =
                cols.iter().filter(|c| !skip.contains(&c.name)).collect();
            if insertable.is_empty() {
                format!("INSERT INTO {} DEFAULT VALUES RETURNING ctid::text", table_path(table))
            } else {
                let names = insertable.iter().map(|c| qi(&c.name)).collect::<Vec<_>>().join(", ");
                let vals = insertable
                    .iter()
                    .map(|c| match &c.value {
                        None => "NULL".to_string(),
                        Some(s) => ql(s),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "INSERT INTO {} ({names}) VALUES ({vals}) RETURNING ctid::text",
                    table_path(table)
                )
            }
        }
        UndoStmt::Delete { table, locator, guards, .. } => format!(
            "DELETE FROM {} WHERE {} RETURNING *",
            table_path(table),
            where_preds(locator, guards, None).join(" AND "),
        ),
    }
}

/// toggle-stable description flip for redo rows
fn flip_description(desc: &str) -> String {
    match desc.strip_prefix("undo of ") {
        Some(rest) => rest.to_string(),
        None => format!("undo of {desc}"),
    }
}

/// Revert plan for a committed DELETE batch: one INSERT per deleted row,
/// columns + values from each DELETE's `RETURNING *`, type identity + skip
/// flags (GENERATED / identity-ALWAYS) from the catalog probe that rode the
/// batch. Any name the probe can't identify → refuse the revert (None) rather
/// than persist a wrong one.
fn build_delete_revert(
    table: &TableRef,
    delete_results: &[StatementResult],
    probe: Option<&StatementResult>,
) -> Option<UndoPlan> {
    let probe = probe?;
    // attname → (skip, type_name, cast)
    let mut meta: HashMap<&str, (bool, String, String)> = HashMap::new();
    let mut skip: Vec<String> = Vec::new();
    for row in &probe.rows {
        let name = row.first()?.as_deref()?;
        let is_skip = row.get(1)?.as_deref()? == "true";
        let type_name = row.get(2)?.as_deref()?;
        let type_schema = row.get(3)?.as_deref()?;
        if is_skip {
            skip.push(name.to_string());
        }
        meta.insert(
            name,
            (
                is_skip,
                type_name.to_string(),
                cast_of_parts(type_schema, type_name),
            ),
        );
    }
    let mut stmts = Vec::with_capacity(delete_results.len());
    for res in delete_results {
        let row = res.rows.first()?;
        if res.columns.len() != row.len() {
            return None;
        }
        let mut cols = Vec::with_capacity(row.len());
        for (c, v) in res.columns.iter().zip(row.iter()) {
            let (_, type_name, cast) = meta.get(c.name.as_str())?;
            cols.push(UndoCol {
                name: c.name.clone(),
                type_name: type_name.clone(),
                cast: cast.clone(),
                value: v.clone(),
                use_default: false,
            });
        }
        stmts.push(UndoStmt::Insert {
            table: table.clone(),
            cols,
            skip: skip.clone(),
        });
    }
    let n = stmts.len();
    let mut tables = HashSet::new();
    tables.insert(format!("{}.{}", table.schema, table.name));
    Some(UndoPlan {
        stmts,
        description: describe_batch("deleted row", n, &tables),
    })
}

/// Inverse of one just-applied revert statement, from its verified result
/// (exactly 1 RETURNING row — the caller checked). Update ↔ Update via the
/// shared capture layout; Insert → Delete via the returned ctid + value pins;
/// Delete → Insert via its RETURNING * matched back by column name.
fn build_inverse(stmt: &UndoStmt, res: &StatementResult) -> Option<UndoStmt> {
    match stmt {
        UndoStmt::Update(meta) => inverse_of_update(meta, res.rows.first()?),
        UndoStmt::Insert { table, cols, skip } => {
            let ctid = res.rows.first()?.first()?.clone();
            ctid.as_ref()?;
            Some(UndoStmt::Delete {
                table: table.clone(),
                locator: vec![UndoCol {
                    name: "ctid".into(),
                    type_name: "tid".into(),
                    cast: "tid".into(),
                    value: ctid,
                    use_default: false,
                }],
                guards: cols
                    .iter()
                    .filter(|c| !skip.contains(&c.name))
                    .cloned()
                    .collect(),
                cols: cols.clone(),
                skip: skip.clone(),
            })
        }
        UndoStmt::Delete { table, cols, skip, .. } => {
            let row = res.rows.first()?;
            if res.columns.len() != row.len() {
                return None;
            }
            let mut by_name: HashMap<&str, &Option<String>> = HashMap::new();
            for (c, v) in res.columns.iter().zip(row.iter()) {
                by_name.insert(c.name.as_str(), v);
            }
            let mut refreshed = Vec::with_capacity(cols.len());
            for c in cols {
                let v = by_name.get(c.name.as_str())?;
                refreshed.push(UndoCol { value: (*v).clone(), ..c.clone() });
            }
            Some(UndoStmt::Insert {
                table: table.clone(),
                cols: refreshed,
                skip: skip.clone(),
            })
        }
    }
}

/// Attname-verification predicates for hint-fed plans. A snapshot-donated
/// attnum→name pair can go stale in a way row locators can't catch (RENAME
/// the old column + ADD COLUMN under the old name → the generated SQL hits
/// the WRONG column and still matches 1 row), so every hint-named column a
/// statement uses gets an attname probe ANDed into its WHERE — a mismatch
/// matches 0 rows and the existing verify-then-commit machinery rolls the
/// whole batch back. The probes ride the same batch: still 2 RTTs.
#[derive(Default)]
struct NameGuards(BTreeMap<(u32, i16), String>);

impl NameGuards {
    fn note(&mut self, m: &ColumnEditMeta, name: &str) {
        if !m.is_ctid && m.table_oid != 0 && m.attnum > 0 {
            self.0.insert((m.table_oid, m.attnum), name.to_string());
        }
    }

    fn predicates(&self) -> impl Iterator<Item = String> + '_ {
        self.0.iter().map(|((oid, att), name)| {
            format!(
                "(SELECT attname FROM pg_attribute WHERE attrelid = {oid} AND attnum = {att}) = {}",
                ql(name)
            )
        })
    }
}

/// mismatch message for a hint-fed statement that matched 0 rows — the name
/// guards make "column identity changed" one of the honest causes
fn hinted_zero_matched() -> String {
    "0 rows matched (expected 1) — row locator stale or column identity changed; \
     refresh and retry"
        .into()
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

/// process-global sequence: every batch gets its OWN savepoint name, so our
/// cleanup can never roll back or destroy a user's identically-named savepoint
static EDIT_SP_SEQ: AtomicUsize = AtomicUsize::new(0);

fn next_edit_savepoint() -> String {
    format!("qwry_edit_sp_{}", EDIT_SP_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// how the verified batch is transaction-wrapped
enum BatchTx {
    /// session was idle — our own BEGIN…COMMIT
    Own,
    /// inside the user's open transaction — SAVEPOINT/RELEASE under a unique
    /// per-batch name, NEVER commit
    Savepoint(String),
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

        let prepared = {
            // busy-marked like any statement — cancel escalation's completion
            // polling must see catalog work on this session too
            let _busy = super::BusyGuard::new(&self.busy);
            self.client.prepare(stmt_sql).await
        }
        .map_err(|e| {
            // a failed prepare inside an explicit tx aborts it
            self.note_error_outcome(stmt_sql);
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
                    hinted: true,
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
            hinted: false,
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
        self.refuse_failed_tx()?;
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        let planned = plan_edits(&map, &edits)?;
        if planned.is_empty() {
            return Ok(EditOutcome { results: vec![], committed: false, revert: None });
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
            // capture layout: old values 0..n, NEW values n..2n (the grid
            // refresh), post-update locator after that
            let n_sets = p.meta.sets.len();
            if matched == 1 {
                for (ret_pos, &ei) in p.edit_indices.iter().enumerate() {
                    results[ei] = EditResult {
                        ok: true,
                        message: None,
                        new_value: row.and_then(|r| r.get(n_sets + ret_pos).cloned()).flatten(),
                    };
                }
            } else {
                mismatch = true;
                let message = if matched == 0 && map.hinted {
                    hinted_zero_matched()
                } else {
                    format!("{matched} rows matched (expected 1)")
                };
                for &ei in &p.edit_indices {
                    results[ei] = EditResult {
                        ok: false,
                        message: Some(message.clone()),
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
            return Ok(EditOutcome { results, committed: false, revert: None });
        }
        // revert plan from the captured old values — refused (None) rather
        // than persisted wrong if any row misses the capture layout
        let revert = {
            let mut stmts = Vec::with_capacity(planned.len());
            let mut tables: HashSet<String> = HashSet::new();
            let mut complete = true;
            for (p, stmt) in planned.iter().zip(out.iter()) {
                tables.insert(format!("{}.{}", p.meta.table.schema, p.meta.table.name));
                match stmt.rows.first().and_then(|row| inverse_of_update(&p.meta, row)) {
                    Some(s) => stmts.push(s),
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            if complete {
                Some(UndoPlan {
                    stmts,
                    description: describe_batch("edit", edits.len(), &tables),
                })
            } else {
                None
            }
        };
        match self.finish_batch(&mode).await {
            Ok(()) => Ok(EditOutcome { results, committed: true, revert }),
            Err(e) => {
                self.undo_batch(&mode).await;
                Err(e)
            }
        }
    }

    /// Delete rows of a single table by locator (PK or ctid, plus any extra
    /// old-value guard pairs). Same batched verify-then-commit contract as
    /// `apply_edits`: one wrapped batch, every DELETE must match exactly one
    /// row or the whole batch rolls back. Each DELETE captures the full row
    /// via `RETURNING *`; a catalog probe (column names, types, generated/
    /// identity-ALWAYS flags) rides the same batch — its result set is
    /// accounted for explicitly, so the n+1 verification stays exact.
    pub async fn delete_rows(
        &self,
        sql: &str,
        statement_index: u32,
        table_oid: u32,
        rows: Vec<Vec<(u32, Option<String>)>>,
        map_hint: Option<EditMapHint>,
    ) -> Result<EditOutcome> {
        self.refuse_failed_tx()?;
        let map = self.resolve_map(sql, statement_index, map_hint).await?;
        let table = map
            .tables
            .get(&table_oid)
            .ok_or_else(|| DriverError::Internal("unknown table for delete".into()))?;

        let mut deletes = Vec::with_capacity(rows.len());
        for locator in &rows {
            let mut where_parts = Vec::new();
            let mut guards = NameGuards::default();
            for (c, v) in locator {
                let m = map
                    .col_meta(*c)
                    .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
                let n = map
                    .name_of(m)
                    .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
                where_parts.push(eq_pred(&n, m, v));
                guards.note(m, &n);
            }
            if where_parts.is_empty() {
                return Err(DriverError::Internal(
                    "refusing to delete with an empty row locator".into(),
                ));
            }
            if map.hinted {
                where_parts.extend(guards.predicates());
            }
            deletes.push(format!(
                "DELETE FROM {} WHERE {} RETURNING *",
                table_path(table),
                where_parts.join(" AND "),
            ));
        }
        if deletes.is_empty() {
            return Ok(EditOutcome { results: vec![], committed: false, revert: None });
        }
        // rides the batch (zero extra round trips): column identity + skip
        // flags for the revert INSERTs. DDL can't shift it mid-batch — the
        // DELETEs' ROW EXCLUSIVE lock blocks ALTER TABLE until we finish.
        let probe = format!(
            "SELECT a.attname, (a.attgenerated <> '' OR a.attidentity = 'a')::text, \
                    t.typname, n.nspname \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             JOIN pg_namespace n ON n.oid = t.typnamespace \
             WHERE a.attrelid = {table_oid} AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        );

        let (mut out, mode) = self
            .run_verified_batch(deletes.iter().map(|d| d.as_str()).chain(std::iter::once(probe.as_str())))
            .await?;
        // n deletes + the probe — run_verified_batch verified the total count
        let probe_out = out.pop();

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
                } else if matched == 0 && map.hinted {
                    Some(hinted_zero_matched())
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
            return Ok(EditOutcome { results, committed: false, revert: None });
        }
        let revert = build_delete_revert(table, &out, probe_out.as_ref());
        match self.finish_batch(&mode).await {
            Ok(()) => Ok(EditOutcome { results, committed: true, revert }),
            Err(e) => {
                self.undo_batch(&mode).await;
                Err(e)
            }
        }
    }

    /// Apply a persisted revert plan as one verified batch on this session —
    /// the same pipeline as commits: SAVEPOINT-wrapped inside a user tx,
    /// per-statement RETURNING counts, full rollback on any mismatch with an
    /// honest message. On success the captured values yield the inverse plan
    /// (redo). Runs on the tab's session, so prod safe-mode's server-side
    /// read-only guard applies to undo exactly as to any write.
    pub async fn apply_revert(&self, plan: &UndoPlan) -> Result<(UndoOutcome, Option<UndoPlan>)> {
        if plan.stmts.is_empty() {
            return Ok((
                UndoOutcome { committed: false, message: Some("empty undo plan".into()) },
                None,
            ));
        }
        let sqls: Vec<String> = plan.stmts.iter().map(revert_stmt_sql).collect();
        let (out, mode) = self
            .run_verified_batch(sqls.iter().map(|s| s.as_str()))
            .await?;

        let mut redo: Vec<UndoStmt> = Vec::new();
        let mut redo_complete = true;
        for (stmt, res) in plan.stmts.iter().zip(out.iter()) {
            if res.rows.len() != 1 {
                self.undo_batch(&mode).await;
                return Ok((
                    UndoOutcome {
                        committed: false,
                        message: Some(
                            "undo no longer matches — data changed since; rolled back".into(),
                        ),
                    },
                    None,
                ));
            }
            match build_inverse(stmt, res) {
                Some(s) => redo.push(s),
                None => redo_complete = false, // undo still valid; just no redo
            }
        }
        match self.finish_batch(&mode).await {
            Ok(()) => {
                let redo_plan = if redo_complete {
                    Some(UndoPlan {
                        stmts: redo,
                        description: flip_description(&plan.description),
                    })
                } else {
                    None
                };
                Ok((UndoOutcome { committed: true, message: None }, redo_plan))
            }
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
        let mut guards = NameGuards::default();
        guards.note(m, &name);
        for (c, v) in &locator {
            let lm = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
            let ln = map
                .name_of(lm)
                .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
            where_parts.push(eq_pred(&ln, lm, v));
            guards.note(lm, &ln);
        }
        if map.hinted {
            where_parts.extend(guards.predicates());
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
            if rows.is_empty() && map.hinted {
                return Err(DriverError::Internal(
                    "cell fetch matched 0 rows (expected 1) — row locator stale or \
                     column identity changed; refresh and retry"
                        .into(),
                ));
            }
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
    /// an edit/delete batch must never start inside an aborted transaction —
    /// even our SAVEPOINT would fail there, and the only honest fix is the
    /// user's own ROLLBACK
    fn refuse_failed_tx(&self) -> Result<()> {
        if self.tx_state() == TxState::FailedTx {
            return Err(DriverError::Internal(
                "current transaction is aborted — ROLLBACK first".into(),
            ));
        }
        Ok(())
    }

    async fn run_verified_batch<'a>(
        &self,
        stmts: impl Iterator<Item = &'a str>,
    ) -> Result<(Vec<StatementResult>, BatchTx)> {
        self.refuse_failed_tx()?;
        let mode = if self.tx_state() == TxState::Idle {
            BatchTx::Own
        } else {
            BatchTx::Savepoint(next_edit_savepoint())
        };
        let mut batch = match &mode {
            BatchTx::Own => String::from("BEGIN"),
            BatchTx::Savepoint(sp) => format!("SAVEPOINT {sp}"),
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
            BatchTx::Savepoint(sp) => {
                format!("ROLLBACK TO SAVEPOINT {sp}; RELEASE SAVEPOINT {sp}")
            }
        };
        let _ = self.execute_simple(&sql).await;
    }

    /// make the batch durable (Own: COMMIT) or fold it into the user's open
    /// transaction (Savepoint: RELEASE — their COMMIT decides durability)
    async fn finish_batch(&self, mode: &BatchTx) -> Result<()> {
        let sql = match mode {
            BatchTx::Own => "COMMIT".to_string(),
            BatchTx::Savepoint(sp) => format!("RELEASE SAVEPOINT {sp}"),
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
        // length-prefixed value components — an unescaped separator would let
        // two composite text PKs collide into one group and write one row's
        // edit into the other (("v|1=w","z") vs ("v","w|1=z"))
        let mut sig = e.table_oid.to_string();
        for (c, v) in &e.pk {
            sig.push('|');
            sig.push_str(&c.to_string());
            match v {
                None => sig.push_str("=N"),
                Some(s) => {
                    sig.push('=');
                    sig.push_str(&s.len().to_string());
                    sig.push(':');
                    sig.push_str(s);
                }
            }
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

        let mut sets: Vec<UndoCol> = Vec::new();
        let mut edit_indices = Vec::new();
        let mut ng = NameGuards::default();
        for (ei, c, v, use_default) in &g.sets {
            let m = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("edited column not in map".into()))?;
            let n = map
                .name_of(m)
                .ok_or_else(|| DriverError::Internal("column name lookup failed".into()))?;
            ng.note(m, &n);
            sets.push(UndoCol {
                name: n,
                type_name: m.type_name.clone(),
                cast: m.cast.clone(),
                value: v.clone(),
                use_default: *use_default,
            });
            edit_indices.push(*ei);
        }

        let mut locator: Vec<UndoCol> = Vec::new();
        let mut guard_cols: Vec<UndoCol> = Vec::new();
        let mut seen_where: HashSet<u32> = HashSet::new();
        for (is_pk, (c, v)) in g
            .pk
            .iter()
            .map(|p| (true, p))
            .chain(g.guard.iter().map(|p| (false, p)))
        {
            if !seen_where.insert(*c) {
                continue;
            }
            let m = map
                .col_meta(*c)
                .ok_or_else(|| DriverError::Internal("bad locator column".into()))?;
            let n = map
                .name_of(m)
                .ok_or_else(|| DriverError::Internal("locator name lookup failed".into()))?;
            ng.note(m, &n);
            let col = UndoCol {
                name: n,
                type_name: m.type_name.clone(),
                cast: m.cast.clone(),
                value: v.clone(),
                use_default: false,
            };
            if is_pk {
                locator.push(col);
            } else {
                guard_cols.push(col);
            }
        }
        if g.pk.is_empty() || locator.is_empty() {
            return Err(DriverError::Internal(
                "refusing to update with an empty row locator".into(),
            ));
        }

        let meta = CaptureMeta {
            table: table.clone(),
            sets,
            locator,
            guards: guard_cols,
            // captured for the revert plan on BOTH paths; only hinted commit
            // SQL includes them (derived names are server truth at commit)
            name_guards: ng.0.iter().map(|((o, a), n)| (*o, *a, n.clone())).collect(),
        };
        planned.push(PlannedUpdate {
            sql: build_capture_update(&meta, map.hinted),
            edit_indices,
            meta,
        });
    }
    Ok(planned)
}

/// human description for an undo-log row ("2 edits on public.t")
fn describe_batch(action: &str, n: usize, tables: &HashSet<String>) -> String {
    let what = if tables.len() == 1 {
        tables.iter().next().cloned().unwrap_or_default()
    } else {
        format!("{} tables", tables.len())
    };
    format!("{n} {action}{} on {what}", if n == 1 { "" } else { "s" })
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
            hinted: false,
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
            planned[0].sql.starts_with(r#"UPDATE "sch.dot"."ta.ble" AS __t SET"#),
            "{}",
            planned[0].sql
        );
        assert!(
            planned[0].sql.contains(r#"FROM (SELECT "id" FROM "sch.dot"."ta.ble" WHERE"#),
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
        // capture grammar carries the full WHERE twice (inner FOR UPDATE
        // subselect + outer) — the locator must appear exactly once in EACH,
        // never duplicated by the guard repeating it
        assert_eq!(sql.matches(r#""id" ="#).count(), 2, "{sql}");
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

    /// composite text PK map: two text columns (attnums 1, 2) both in the PK
    fn text_pk_map() -> ResolvedMap {
        let mut tables = HashMap::new();
        tables.insert(9u32, TableRef { schema: "public".into(), name: "t".into() });
        let mut names = HashMap::new();
        names.insert((9u32, 1i16), "p".to_string());
        names.insert((9u32, 2i16), "q".to_string());
        names.insert((9u32, 3i16), "v".to_string());
        ResolvedMap {
            columns: vec![
                meta(0, 9, 1, "text", "text", false),
                meta(1, 9, 2, "text", "text", false),
                meta(2, 9, 3, "text", "text", false),
            ],
            tables,
            names,
            hinted: false,
        }
    }

    #[test]
    fn group_signature_separator_collision() {
        // the audit pair: ("v|1=w","z") and ("v","w|1=z") built identical
        // unescaped signatures — they must plan as TWO updates, never one
        let map = text_pk_map();
        let edits = vec![
            RowEdit {
                table_oid: 9,
                col: 2,
                value: Some("x".into()),
                use_default: false,
                pk: vec![(0, Some("v|1=w".into())), (1, Some("z".into()))],
                guard: vec![],
            },
            RowEdit {
                table_oid: 9,
                col: 2,
                value: Some("y".into()),
                use_default: false,
                pk: vec![(0, Some("v".into())), (1, Some("w|1=z".into()))],
                guard: vec![],
            },
        ];
        let planned = plan_edits(&map, &edits).unwrap();
        assert_eq!(planned.len(), 2, "colliding signatures merged two rows into one UPDATE");
        assert!(planned[0].sql.contains("'v|1=w'"), "{}", planned[0].sql);
        assert!(planned[1].sql.contains("'w|1=z'"), "{}", planned[1].sql);
        // NULL stays distinct from any literal value
        let edits = vec![
            RowEdit {
                table_oid: 9,
                col: 2,
                value: Some("x".into()),
                use_default: false,
                pk: vec![(0, None), (1, Some("a".into()))],
                guard: vec![],
            },
            RowEdit {
                table_oid: 9,
                col: 2,
                value: Some("y".into()),
                use_default: false,
                pk: vec![(0, Some("N".into())), (1, Some("a".into()))],
                guard: vec![],
            },
        ];
        assert_eq!(plan_edits(&map, &edits).unwrap().len(), 2);
    }

    #[test]
    fn hinted_plans_carry_attname_guards() {
        let mut map = test_map();
        map.hinted = true;
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 1,
            value: Some("x".into()),
            use_default: false,
            pk: vec![(0, Some("1".into()))],
            guard: vec![],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        let sql = &planned[0].sql;
        // one guard per hint-named column used (SET col attnum 2 + pk attnum 1)
        assert!(
            sql.contains(
                "(SELECT attname FROM pg_attribute WHERE attrelid = 7 AND attnum = 1) = 'id'"
            ),
            "{sql}"
        );
        assert!(
            sql.contains(
                "(SELECT attname FROM pg_attribute WHERE attrelid = 7 AND attnum = 2) = 'Name'"
            ),
            "{sql}"
        );
        // derived plans stay guard-free
        map.hinted = false;
        let planned = plan_edits(&map, &edits).unwrap();
        assert!(!planned[0].sql.contains("pg_attribute"), "{}", planned[0].sql);
    }

    #[test]
    fn savepoint_names_unique() {
        let a = next_edit_savepoint();
        let b = next_edit_savepoint();
        assert_ne!(a, b);
        assert!(a.starts_with("qwry_edit_sp_"), "{a}");
        assert!(b.starts_with("qwry_edit_sp_"), "{b}");
    }

    // ---- inverse-SQL undo -------------------------------------------------

    #[test]
    fn capture_grammar_shape() {
        let map = test_map();
        let edits = vec![RowEdit {
            table_oid: 7,
            col: 1,
            value: Some("x".into()),
            use_default: false,
            pk: vec![(0, Some("1".into()))],
            guard: vec![],
        }];
        let planned = plan_edits(&map, &edits).unwrap();
        let sql = &planned[0].sql;
        assert!(sql.contains("FOR UPDATE) AS __old"), "{sql}");
        assert!(sql.contains(r#"WHERE __t."id" = '1'::int4"#), "{sql}");
        // RETURNING layout: old set values, new set values, post-update locator
        assert!(
            sql.ends_with(r#"RETURNING __old."Name"::text, __t."Name"::text, __t."id"::text"#),
            "{sql}"
        );
        // inner captures ONLY the changed columns
        assert!(sql.contains(r#"(SELECT "Name" FROM "#), "{sql}");
    }

    #[test]
    fn inverse_of_update_roundtrips() {
        let col = |name: &str, val: Option<&str>| UndoCol {
            name: name.into(),
            type_name: "text".into(),
            cast: "text".into(),
            value: val.map(String::from),
            use_default: false,
        };
        let meta = CaptureMeta {
            table: TableRef { schema: "public".into(), name: "t".into() },
            sets: vec![col("v", Some("new"))],
            locator: vec![col("id", Some("1"))],
            guards: vec![col("other", Some("o"))],
            name_guards: vec![(7, 2, "v".into())],
        };
        // captured row: old value, new value, post-update locator
        let row = vec![Some("old".to_string()), Some("new-norm".to_string()), Some("1".to_string())];
        let inv = inverse_of_update(&meta, &row).unwrap();
        let UndoStmt::Update(rev) = &inv else { panic!("expected update") };
        assert_eq!(rev.sets[0].value.as_deref(), Some("old"), "revert restores the OLD value");
        assert_eq!(rev.locator[0].value.as_deref(), Some("1"));
        // guards: the value we wrote (server-normalized) + untouched original guard
        assert_eq!(rev.guards.len(), 2);
        assert_eq!(rev.guards[0].name, "v");
        assert_eq!(rev.guards[0].value.as_deref(), Some("new-norm"));
        assert_eq!(rev.guards[1].name, "other");
        assert_eq!(rev.guards[1].value.as_deref(), Some("o"));
        assert_eq!(rev.name_guards, meta.name_guards);

        // applying the revert captures (old="new-norm" side now) → redo
        let row2 = vec![Some("new-norm".to_string()), Some("old".to_string()), Some("1".to_string())];
        let redo = inverse_of_update(rev, &row2).unwrap();
        let UndoStmt::Update(redo) = &redo else { panic!("expected update") };
        assert_eq!(redo.sets[0].value.as_deref(), Some("new-norm"), "redo re-applies the commit");
        assert_eq!(redo.guards[0].value.as_deref(), Some("old"));

        // short row = accounting drift → refuse, never a wrong revert
        assert!(inverse_of_update(&meta, &[Some("x".into())]).is_none());
    }

    #[test]
    fn revert_sql_shapes() {
        let col = |name: &str, val: Option<&str>| UndoCol {
            name: name.into(),
            type_name: "text".into(),
            cast: "text".into(),
            value: val.map(String::from),
            use_default: false,
        };
        let table = TableRef { schema: "public".into(), name: "t".into() };
        // INSERT excludes skip (generated / identity-ALWAYS) columns
        let ins = UndoStmt::Insert {
            table: table.clone(),
            cols: vec![col("id", Some("1")), col("gen", Some("2")), col("v", None)],
            skip: vec!["gen".into()],
        };
        assert_eq!(
            revert_stmt_sql(&ins),
            r#"INSERT INTO "public"."t" ("id", "v") VALUES ('1', NULL) RETURNING ctid::text"#
        );
        // all columns generated → DEFAULT VALUES
        let ins2 = UndoStmt::Insert {
            table: table.clone(),
            cols: vec![col("gen", Some("2"))],
            skip: vec!["gen".into()],
        };
        assert!(revert_stmt_sql(&ins2).contains("DEFAULT VALUES"));
        // DELETE: ctid locator + value pins, RETURNING * for the next inverse
        let del = UndoStmt::Delete {
            table,
            locator: vec![UndoCol {
                name: "ctid".into(),
                type_name: "tid".into(),
                cast: "tid".into(),
                value: Some("(0,3)".into()),
                use_default: false,
            }],
            guards: vec![col("v", Some("x"))],
            cols: vec![],
            skip: vec![],
        };
        assert_eq!(
            revert_stmt_sql(&del),
            r#"DELETE FROM "public"."t" WHERE "ctid" = '(0,3)'::tid AND "v" = 'x'::text RETURNING *"#
        );
    }

    fn stmt_result(cols: &[&str], rows: Vec<Vec<Option<String>>>) -> StatementResult {
        StatementResult {
            index: 0,
            sql: String::new(),
            columns: cols
                .iter()
                .map(|n| crate::driver::ColumnMeta {
                    name: (*n).to_string(),
                    type_oid: 0,
                    table_oid: 0,
                    attnum: 0,
                })
                .collect(),
            rows,
            affected: None,
            ms: 0.0,
        }
    }

    #[test]
    fn delete_revert_and_insert_inverse() {
        let table = TableRef { schema: "public".into(), name: "t".into() };
        // probe: attname, skip, typname, nspname (attnum order)
        let probe = stmt_result(
            &["attname", "skip", "typname", "nspname"],
            vec![
                vec![Some("id".into()), Some("false".into()), Some("int4".into()), Some("pg_catalog".into())],
                vec![Some("v".into()), Some("false".into()), Some("text".into()), Some("pg_catalog".into())],
                vec![Some("dbl".into()), Some("true".into()), Some("int4".into()), Some("pg_catalog".into())],
            ],
        );
        let deleted = stmt_result(
            &["id", "v", "dbl"],
            vec![vec![Some("1".into()), None, Some("2".into())]],
        );
        let plan = build_delete_revert(&table, &[deleted], Some(&probe)).unwrap();
        assert_eq!(plan.stmts.len(), 1);
        let UndoStmt::Insert { cols, skip, .. } = &plan.stmts[0] else { panic!("expected insert") };
        assert_eq!(skip, &vec!["dbl".to_string()]);
        assert_eq!(cols.len(), 3, "ALL columns captured, skip filtered at SQL time");
        assert_eq!(
            revert_stmt_sql(&plan.stmts[0]),
            r#"INSERT INTO "public"."t" ("id", "v") VALUES ('1', NULL) RETURNING ctid::text"#
        );

        // applying the INSERT yields a Delete inverse via the returned ctid
        let ins_res = stmt_result(&["ctid"], vec![vec![Some("(0,9)".into())]]);
        let inv = build_inverse(&plan.stmts[0], &ins_res).unwrap();
        let UndoStmt::Delete { locator, guards, .. } = &inv else { panic!("expected delete") };
        assert_eq!(locator[0].name, "ctid");
        assert_eq!(locator[0].value.as_deref(), Some("(0,9)"));
        assert!(guards.iter().all(|g| g.name != "dbl"), "skip cols never pin identity");

        // applying the DELETE yields the Insert back, values refreshed by NAME
        let del_res = stmt_result(
            &["id", "v", "dbl"],
            vec![vec![Some("1".into()), None, Some("2".into())]],
        );
        let back = build_inverse(&inv, &del_res).unwrap();
        assert!(matches!(back, UndoStmt::Insert { .. }));

        // a probe row with a NULL name refuses the plan
        let bad_probe = stmt_result(
            &["attname", "skip", "typname", "nspname"],
            vec![vec![None, Some("false".into()), Some("int4".into()), Some("pg_catalog".into())]],
        );
        let deleted2 = stmt_result(&["id"], vec![vec![Some("1".into())]]);
        assert!(build_delete_revert(&table, &[deleted2], Some(&bad_probe)).is_none());
    }

    #[test]
    fn description_flip_toggles() {
        assert_eq!(flip_description("2 edits on public.t"), "undo of 2 edits on public.t");
        assert_eq!(flip_description("undo of 2 edits on public.t"), "2 edits on public.t");
    }
}
