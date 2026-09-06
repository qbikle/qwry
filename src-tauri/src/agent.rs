//! Agent core: the Rust half of AGENT-SPEC. TypeScript owns the turn loop
//! (§2), Rust owns the database, the AST gate and the Keychain.
//!
//! Everything here runs on a *dedicated* agent session: `agent_connect` opens
//! one with `default_transaction_read_only=on` forced at the server regardless
//! of the profile's prod flag (§2.3, §8.1), registers it in `state.sessions`
//! like any other session, so `disconnect` / `cancel` / `session_probe` work on
//! it unchanged, and hands its id back. Every tool command below takes that id.
//!
//! Read-only is enforced twice and neither half is optional: the server-side
//! transaction flag, and `classify()` over the parsed statement. `run_sql`
//! rejections come back in the same `ERROR: <first line>` shape a real SQL
//! error does, so the repair loop needs no special case (W0 port note).
//!
//! Every tool body is a free function over `&PgSession`; the `#[tauri::command]`
//! wrappers only resolve the session id. `agent_mcp.rs` serves the same tools to
//! the `claude -p` provider and calls those free functions directly.
//!
//! Types here are mirrored by hand in `src/ipc/types.ts` (CLAUDE.md rule);
//! change one, change the other.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use pg_query::protobuf::{CommonTableExpr, Node, SelectStmt};
use pg_query::NodeEnum;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::appdb::{AgentAnswer, AgentThread, AgentTurn, AgentTurnInput, AgentTurnPatch};
use crate::driver::postgres::edit::{qi, ql, TableRef};
use crate::driver::postgres::PgSession;
use crate::driver::{DriverError, Result, SessionId};
use crate::state::AppState;

/// full result rows kept for the UI grid (§5); the loop shows the model 50
pub const UI_ROW_CAP: u32 = 2_000;
/// `probe` takes at most this many queries in one call (§5)
pub const PROBE_MAX: usize = 6;
/// rows returned per probe query (§5)
pub const PROBE_ROW_CAP: u32 = 5;
/// `peek_values` upper bound on `limit` (§5)
pub const PEEK_MAX: u32 = 50;
/// distinct values per column carried in a `describe_tables` block (§5)
pub const VALUES_CAP: usize = 20;
/// tables per `describe_tables` call; matches `tools.schema.json` `maxItems`
pub const DESCRIBE_MAX: usize = 40;

/// a sampled value longer than this is prose, not a category: the whole column
/// is dropped rather than spending the turn's context on one long string
/// (`harness.py` `sample_values`)
const VALUE_LEN_CAP: usize = 40;
/// `peek_values` runs under its own short timeouts (§5): the exact DISTINCT
/// gets this long before the peek falls back to a bounded sample, so a wide
/// unindexed column on a big table costs 2s, not a dead tool
const PEEK_EXACT_TIMEOUT_MS: u64 = 2_000;
/// the sampled fallback's own cap (the whole peek stays under ~7s)
const PEEK_TIMEOUT_MS: u64 = 5_000;
/// rows the sampled fallback reads at most, from random pages
/// (`TABLESAMPLE SYSTEM`), before it looks for distinct values
const PEEK_SCAN_ROWS: u64 = 20_000;
/// share of pages the sampled fallback visits (percent)
const PEEK_SAMPLE_PCT: &str = "0.5";
/// probe queries get `run_sql`'s default timeout; §5 gives probe no setting
const PROBE_TIMEOUT_MS: u64 = 10_000;
/// floor/ceiling for the caller's `run_sql` timeout setting
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

/// One executed read-only statement. `rows` are wire text (what psql shows),
/// `None` = SQL NULL, exactly like `driver::StatementResult`. `capped` means
/// the result was longer than `max_rows` and only the first `max_rows` are
/// carried; `row_count` is what the statement actually produced.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRun {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: u64,
    pub capped: bool,
    pub ms: f64,
}

/// Distinct non-null values of one column. `more` drives the tool text's
/// `… (more exist)` marker, so the model knows the list is not exhaustive.
#[derive(Debug, Clone, Serialize)]
pub struct PeekResult {
    pub values: Vec<String>,
    pub more: bool,
    /// the exact DISTINCT timed out and the values come from a bounded sample
    /// of random pages: other values may exist, and the model is told so
    pub sampled: bool,
}

/// One probe query's outcome. `run` and `error` are mutually exclusive: a
/// gate rejection or a SQL error fills `error` with the first line only.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub sql: String,
    pub run: Option<AgentRun>,
    pub error: Option<String>,
}

/// AST-gate outcome (§8.1). `reason` is the refusal text, already phrased for
/// the model and for the Fix It affordance; `None` when allowed.
#[derive(Debug, Clone, Serialize)]
pub struct GateVerdict {
    pub allowed: bool,
    pub reason: Option<String>,
}

/// Low-cardinality values for one table, from `pg_stats` (free: no scan, only
/// as fresh as the last ANALYZE), plus the table's own comment. TS composes
/// the DDL text the model reads from the cached `SchemaSnapshot` plus these.
#[derive(Debug, Clone, Serialize)]
pub struct TableValues {
    pub schema: String,
    pub name: String,
    /// COMMENT ON TABLE, when there is one
    pub comment: Option<String>,
    pub columns: Vec<ColumnValues>,
}

/// A column carries a values list, a comment, or both; a column with neither
/// is not returned at all.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnValues {
    pub column: String,
    /// at most `VALUES_CAP` entries, sorted
    pub values: Vec<String>,
    /// the column has more distinct values than were carried
    pub more: bool,
    /// COMMENT ON COLUMN, when there is one
    pub comment: Option<String>,
}

// ---- §8.1 the AST gate ----------------------------------------------------

/// Functions that are safe-under-privilege-boundary in some deployments but
/// still deny-listed here because either (a) PUBLIC has EXECUTE by default
/// (`pg_sleep`, `set_config`) so DB role privilege does NOT block them, or
/// (b) the failure should happen pre-flight, in the gate, as an instant error
/// back to the model instead of a 10s statement-timeout round trip.
/// `default_transaction_read_only` has zero effect on any of them: none is a
/// table write (measured, w0-pg-query-gate.md §3).
const DENIED_FUNCS: &[&str] = &[
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_ls_logdir",
    "pg_ls_waldir",
    "pg_ls_tmpdir",
    "lo_import",
    "lo_export",
    "lo_read",
    "lo_write",
    "lo_create",
    "lo_unlink",
    "lo_open",
    "dblink",
    "dblink_exec",
    "dblink_connect",
    "set_config",
    "pg_sleep",
    "pg_sleep_for",
    "pg_sleep_until",
];

const INTO_REASON: &str = "SELECT INTO / CTAS materializes a new table (write)";
const LOCK_REASON: &str = "FOR UPDATE/FOR SHARE takes a row lock";

/// The refusal a model gets when it hands `run_sql` its own sentence instead
/// of a statement. W7: a write request answered in prose, then sent to
/// `run_sql` as prose, spent twelve turns being refused and re-explained,
/// because `parse error: syntax error at or near "I"` reads as a query to fix
/// rather than as a tool that was never wanted. So the refusal names the way
/// out, and `loop.ts` breaks the loop after the second one in a row.
pub const PROSE_REASON: &str =
    "this is prose, not SQL. To answer without running a query, reply in text and call no tool";

/// Every word a statement can open with, `(` for a parenthesised SELECT and
/// `--` / `/*` for a leading comment. A parse failure that opens with none of
/// them is not a broken query; it is prose (PROSE_REASON). Deliberately
/// generous: a write verb belongs to the gate's own refusal, which names the
/// statement kind, not to this one.
const SQL_LEADS: &[&str] = &[
    "select", "with", "explain", "values", "table", "insert", "update", "delete", "merge",
    "create", "drop", "alter", "truncate", "grant", "revoke", "begin", "start", "commit",
    "rollback", "savepoint", "release", "set", "reset", "show", "copy", "call", "do", "analyze",
    "vacuum", "refresh", "comment", "prepare", "execute", "deallocate", "declare", "fetch",
    "move", "close", "listen", "unlisten", "notify", "lock", "reindex", "cluster", "checkpoint",
    "discard", "import", "security", "end", "abort",
];

/// Whether the text at least OPENS like a statement. Punctuation-led text
/// (`(SELECT …`, a leading comment) counts; anything else is judged on its
/// first word, lowercased, stripped of the punctuation a sentence carries.
fn opens_like_sql(sql: &str) -> bool {
    let text = sql.trim_start();
    if text.starts_with('(') || text.starts_with("--") || text.starts_with("/*") {
        return true;
    }
    let word: String = text
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .flat_map(|c| c.to_lowercase())
        .collect();
    SQL_LEADS.contains(&word.as_str())
}

fn is_denied(name: &str) -> bool {
    DENIED_FUNCS.contains(&name.to_ascii_lowercase().as_str())
}

fn dml_reason(verb: &str) -> String {
    format!("data-modifying CTE ({verb})")
}

fn node_enum(n: &Node) -> Option<&NodeEnum> {
    n.node.as_ref()
}

/// Recurse into anything that can appear as a CTE body or the target of a
/// set operation / FROM-clause subquery: only a SELECT (transitively) is
/// acceptable; INSERT/UPDATE/DELETE/MERGE anywhere in the tree is a write.
fn check_top(n: &Node) -> std::result::Result<(), String> {
    match node_enum(n) {
        Some(NodeEnum::SelectStmt(s)) => check_select(s),
        Some(NodeEnum::InsertStmt(_)) => Err(dml_reason("INSERT")),
        Some(NodeEnum::UpdateStmt(_)) => Err(dml_reason("UPDATE")),
        Some(NodeEnum::DeleteStmt(_)) => Err(dml_reason("DELETE")),
        Some(NodeEnum::MergeStmt(_)) => Err(dml_reason("MERGE")),
        _ => Ok(()),
    }
}

fn check_cte(cte: &CommonTableExpr) -> std::result::Result<(), String> {
    match &cte.ctequery {
        Some(q) => check_top(q),
        None => Ok(()),
    }
}

/// pg_query's own `.nodes()` walk never visits `into_clause` or
/// `locking_clause`: verified by reading `node_enum.rs`, where neither field
/// name appears in the hand-written BFS. They exist only as struct fields, so
/// a gate that trusted the crate's traversal would let `SELECT INTO` and
/// `FOR UPDATE` straight through. Hence explicit field reads here, and the
/// generic `sweep` below for every SelectStmt this structural walk cannot
/// reach.
fn check_select(s: &SelectStmt) -> std::result::Result<(), String> {
    if s.into_clause.is_some() {
        return Err(INTO_REASON.into());
    }
    if !s.locking_clause.is_empty() {
        return Err(LOCK_REASON.into());
    }
    if let Some(with) = &s.with_clause {
        for cte_node in &with.ctes {
            if let Some(NodeEnum::CommonTableExpr(cte)) = node_enum(cte_node) {
                check_cte(cte)?;
            }
        }
    }
    if let Some(larg) = &s.larg {
        check_select(larg)?;
    }
    if let Some(rarg) = &s.rarg {
        check_select(rarg)?;
    }
    for f in &s.from_clause {
        check_from_item(f)?;
    }
    Ok(())
}

/// FROM-clause items can hide a subquery (`(WITH d AS (DELETE …) SELECT …) x`)
/// or a join whose sides are themselves subqueries. Table functions, plain
/// RangeVars etc. fall through as fine (they're just reads).
fn check_from_item(n: &Node) -> std::result::Result<(), String> {
    match node_enum(n) {
        Some(NodeEnum::RangeSubselect(rs)) => {
            if let Some(sub) = &rs.subquery {
                check_top(sub)?;
            }
            Ok(())
        }
        Some(NodeEnum::JoinExpr(j)) => {
            if let Some(l) = &j.larg {
                check_from_item(l)?;
            }
            if let Some(r) = &j.rarg {
                check_from_item(r)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn variant_name(n: &NodeEnum) -> String {
    let d = format!("{n:?}");
    d.split('(').next().unwrap_or("?").to_string()
}

/// Belt for the structural walk: a scalar subquery can sit in EVERY expression
/// position (target list, WHERE, HAVING, GROUP BY, ORDER BY, CASE arms,
/// function arguments, LIMIT, VALUES), and neither `check_select` nor
/// pg_query's own walker follows all of them. Measured gap this closes:
/// `SELECT (SELECT actor_id FROM actor WHERE actor_id = 1 FOR UPDATE)` was
/// ALLOWED by the W0 draft.
///
/// The tree is walked as data rather than as typed nodes: serde renders every
/// node the parser produced, so no node kind can fall out of the traversal the
/// way one falls out of a hand-written match. The deny-listed function check
/// rides the same pass for the same reason.
fn sweep(pb: &pg_query::protobuf::ParseResult) -> std::result::Result<(), String> {
    let tree = serde_json::to_value(pb)
        .map_err(|e| format!("could not inspect the parsed statement: {e}"))?;
    let mut stack = vec![&tree];
    while let Some(v) = stack.pop() {
        match v {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    check_tree_node(key, child)?;
                    stack.push(child);
                }
            }
            serde_json::Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    Ok(())
}

/// One node of the serialized parse tree. `key` is the node kind (prost
/// renders a `Node` oneof as `{"SelectStmt": {…}}`), `node` its fields.
fn check_tree_node(key: &str, node: &serde_json::Value) -> std::result::Result<(), String> {
    match key {
        "SelectStmt" => {
            if node.get("into_clause").is_some_and(|c| !c.is_null()) {
                return Err(INTO_REASON.into());
            }
            let locked = node
                .get("locking_clause")
                .and_then(|c| c.as_array())
                .is_some_and(|a| !a.is_empty());
            if locked {
                return Err(LOCK_REASON.into());
            }
        }
        "InsertStmt" => return Err(dml_reason("INSERT")),
        "UpdateStmt" => return Err(dml_reason("UPDATE")),
        "DeleteStmt" => return Err(dml_reason("DELETE")),
        "MergeStmt" => return Err(dml_reason("MERGE")),
        "FuncCall" => {
            if let Some(name) = func_name(node) {
                let short = name.rsplit('.').next().unwrap_or(name.as_str());
                if is_denied(short) {
                    return Err(format!("denied function call: {name}()"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// `funcname` is a list of String nodes, each wrapped in a `Node`:
/// `pg_catalog.pg_sleep` arrives as two of them.
fn func_name(node: &serde_json::Value) -> Option<String> {
    let parts = node.get("funcname")?.as_array()?;
    let segs: Vec<&str> = parts
        .iter()
        .filter_map(|p| p.get("node")?.get("String")?.get("sval")?.as_str())
        .collect();
    (!segs.is_empty()).then(|| segs.join("."))
}

/// The gate (§8.1). Allows exactly one `SELECT` / `WITH … SELECT` / `EXPLAIN`
/// of either, with no data-modifying CTE, no `SELECT INTO`, no
/// `FOR UPDATE`/`FOR SHARE` and no deny-listed function call. A locking clause
/// is REFUSED, never stripped: silently rewriting the model's SQL would break
/// §8.4 (everything the model sends is visible in the trace).
pub fn classify(sql: &str) -> GateVerdict {
    match gate(sql) {
        Ok(()) => GateVerdict { allowed: true, reason: None },
        Err(reason) => GateVerdict { allowed: false, reason: Some(reason) },
    }
}

fn gate(sql: &str) -> std::result::Result<(), String> {
    let parsed = pg_query::parse(sql).map_err(|e| {
        if opens_like_sql(sql) {
            format!("parse error: {e}")
        } else {
            PROSE_REASON.to_string()
        }
    })?;
    let stmts = &parsed.protobuf.stmts;
    if stmts.is_empty() {
        return Err("empty statement".into());
    }
    if stmts.len() > 1 {
        return Err(format!(
            "{} statements in one call; run_sql takes exactly one",
            stmts.len()
        ));
    }
    let node = match stmts[0].stmt.as_ref().and_then(|s| node_enum(s)) {
        Some(n) => n,
        None => return Err("empty statement".into()),
    };
    match node {
        NodeEnum::SelectStmt(s) => check_select(s)?,
        // EXPLAIN of a write never executes the write (measured, W0 §3) but is
        // still out of the tool's scope, so any non-SELECT inner statement is
        // refused regardless of the ANALYZE option.
        NodeEnum::ExplainStmt(e) => match e.query.as_ref().and_then(|q| node_enum(q)) {
            Some(NodeEnum::SelectStmt(inner)) => {
                check_select(inner).map_err(|reason| format!("EXPLAIN of: {reason}"))?
            }
            Some(other) => {
                return Err(format!(
                    "EXPLAIN of a {} (only EXPLAIN SELECT/WITH...SELECT allowed)",
                    variant_name(other)
                ))
            }
            None => return Err("EXPLAIN with no inner query".into()),
        },
        other => {
            return Err(format!(
                "{} not allowed (only SELECT / WITH...SELECT / EXPLAIN)",
                variant_name(other)
            ))
        }
    }
    sweep(&parsed.protobuf)
}

/// A gate refusal reaches the loop in the shape a server error has, so the
/// repair path needs no branch on where the refusal came from.
fn gate_error(reason: &str) -> DriverError {
    DriverError::Db {
        message: reason.to_string(),
        position: None,
        code: None,
        detail: None,
        hint: None,
    }
}

// ---- §5 tools -------------------------------------------------------------

/// `pg_stats` row for one column of one table, as the batch returns it.
#[derive(Debug, Deserialize)]
struct StatRow {
    schema: String,
    table: String,
    column: String,
    n_distinct: Option<f64>,
    reltuples: f64,
    mcv: Option<Vec<Option<String>>>,
    hist: Option<Vec<Option<String>>>,
}

#[derive(Debug, Deserialize)]
struct CommentRow {
    schema: String,
    table: String,
    comment: Option<String>,
    columns: Vec<ColumnComment>,
}

#[derive(Debug, Deserialize)]
struct ColumnComment {
    column: String,
    comment: Option<String>,
}

/// The planner's own estimate of a column's distinct values and the values it
/// sampled, per `harness.py` `sample_values` (pgstats branch), ported rule for
/// rule: `n_distinct < 0` is a FRACTION of the row count, not a count;
/// repeated values land in `most_common_vals` and unique-ish ones in
/// `histogram_bounds`, so the union of both is the sample; a column the
/// planner thinks holds more than `VALUES_CAP` distinct values is not a
/// category and is dropped; so is one with a value longer than
/// `VALUE_LEN_CAP`.
fn low_cardinality(row: &StatRow) -> Option<(Vec<String>, bool)> {
    let nd = row.n_distinct?;
    let est = if nd < 0.0 { -nd * row.reltuples } else { nd };
    if est > VALUES_CAP as f64 {
        return None;
    }
    let mut vals: BTreeSet<String> = BTreeSet::new();
    for list in [&row.mcv, &row.hist].into_iter().flatten() {
        for v in list.iter().flatten() {
            vals.insert(v.clone());
        }
    }
    if vals.is_empty() || vals.iter().any(|v| v.chars().count() > VALUE_LEN_CAP) {
        return None;
    }
    let more = vals.len() > VALUES_CAP;
    Some((vals.into_iter().take(VALUES_CAP).collect(), more))
}

fn json_cell(out: &crate::driver::ExecOutcome, i: usize, what: &str) -> Result<String> {
    out.statements
        .get(i)
        .and_then(|s| s.rows.first())
        .and_then(|r| r.first())
        .and_then(|v| v.clone())
        .ok_or_else(|| DriverError::Internal(format!("{what} returned no rows")))
}

/// Low-cardinality `pg_stats` values plus table and column comments for the
/// given tables, in ONE round trip for all of them: `describe_tables` is a
/// single turn's worth of context, and N round trips would spend the turn's
/// latency (§5). Every requested table gets an entry, in request order, even
/// when it has neither values nor comments, so TS can tell "nothing to say
/// about it" from "it is not there".
pub async fn describe(session: &PgSession, tables: &[TableRef]) -> Result<Vec<TableValues>> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }
    if tables.len() > DESCRIBE_MAX {
        return Err(gate_error(&format!(
            "describe_tables takes at most {DESCRIBE_MAX} tables; {} were asked for",
            tables.len()
        )));
    }
    let pairs = tables
        .iter()
        .map(|t| format!("({}, {})", ql(&t.schema), ql(&t.name)))
        .collect::<Vec<_>>()
        .join(", ");
    // most_common_vals/histogram_bounds are anyarray: the ::text::text[] pair
    // is the only cast that works for every column type (harness.py does the
    // same). pg_stats already hides rows for tables the role cannot read.
    let sql = format!(
        r#"
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT s.schemaname AS schema, s.tablename AS "table", s.attname AS "column",
         s.n_distinct::float8 AS n_distinct,
         c.reltuples::float8 AS reltuples,
         s.most_common_vals::text::text[] AS mcv,
         s.histogram_bounds::text::text[] AS hist
  FROM pg_stats s
  JOIN pg_namespace n ON n.nspname = s.schemaname
  JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.tablename
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = s.attname
    AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type ty ON ty.oid = a.atttypid
  WHERE (s.schemaname, s.tablename) IN ({pairs})
    AND (ty.typtype = 'e' OR ty.typname IN ('text','varchar','bpchar','char'))
  ORDER BY s.schemaname, s.tablename, a.attnum
) t;
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT n.nspname AS schema, c.relname AS "table",
         td.description AS comment,
         coalesce((
           SELECT json_agg(json_build_object('column', a.attname, 'comment', cd.description)
                           ORDER BY a.attnum)
           FROM pg_attribute a
           JOIN pg_description cd ON cd.objoid = c.oid
             AND cd.classoid = 'pg_class'::regclass AND cd.objsubid = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         ), '[]') AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_description td ON td.objoid = c.oid
    AND td.classoid = 'pg_class'::regclass AND td.objsubid = 0
  WHERE (n.nspname, c.relname) IN ({pairs})
) t"#
    );
    let out = session.execute_simple(&sql).await?;
    let parse_err = |what: &str, e: serde_json::Error| {
        DriverError::Internal(format!("describe: {what} unreadable: {e}"))
    };
    let stats: Vec<StatRow> = serde_json::from_str(&json_cell(&out, 0, "column values")?)
        .map_err(|e| parse_err("column values", e))?;
    let comments: Vec<CommentRow> = serde_json::from_str(&json_cell(&out, 1, "comments")?)
        .map_err(|e| parse_err("comments", e))?;

    let mut result = Vec::with_capacity(tables.len());
    for t in tables {
        let mut columns: BTreeMap<String, ColumnValues> = BTreeMap::new();
        for row in stats
            .iter()
            .filter(|r| r.schema == t.schema && r.table == t.name)
        {
            if let Some((values, more)) = low_cardinality(row) {
                columns.insert(
                    row.column.clone(),
                    ColumnValues {
                        column: row.column.clone(),
                        values,
                        more,
                        comment: None,
                    },
                );
            }
        }
        let meta = comments
            .iter()
            .find(|c| c.schema == t.schema && c.table == t.name);
        if let Some(meta) = meta {
            for c in &meta.columns {
                columns
                    .entry(c.column.clone())
                    .or_insert_with(|| ColumnValues {
                        column: c.column.clone(),
                        values: Vec::new(),
                        more: false,
                        comment: None,
                    })
                    .comment = c.comment.clone();
            }
        }
        result.push(TableValues {
            schema: t.schema.clone(),
            name: t.name.clone(),
            comment: meta.and_then(|m| m.comment.clone()),
            columns: columns.into_values().collect(),
        });
    }
    Ok(result)
}

/// Distinct non-null values of one column. The column is validated against
/// `pg_attribute` first, so a wrong guess comes back as the list of real
/// columns rather than a bare SQL error the model has to decode.
pub async fn peek_values(
    session: &PgSession,
    schema: &str,
    table: &str,
    column: &str,
    limit: u32,
) -> Result<PeekResult> {
    let limit = limit.clamp(1, PEEK_MAX);
    let path = format!("{}.{}", qi(schema), qi(table));
    let cols_sql = format!(
        "SELECT a.attname FROM pg_attribute a \
         WHERE a.attrelid = {}::regclass AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        ql(&path)
    );
    let out = session.execute_simple(&cols_sql).await?;
    let columns: Vec<String> = out
        .statements
        .first()
        .map(|s| {
            s.rows
                .iter()
                .filter_map(|r| r.first().cloned().flatten())
                .collect()
        })
        .unwrap_or_default();
    if columns.is_empty() {
        return Err(gate_error(&format!("no readable columns on {schema}.{table}")));
    }
    if !columns.iter().any(|c| c == column) {
        return Err(gate_error(&format!(
            "no column \"{column}\" on {schema}.{table}. Columns: {}",
            columns.join(", ")
        )));
    }
    let col = qi(column);
    let mut sampled = false;
    let out = match session.execute_simple(&peek_exact_sql(&path, &col, limit)).await {
        Ok(out) => out,
        Err(e) if is_statement_timeout(&e) => {
            // a big table: `videos_store` timed every peek out at 5s and the
            // model lost its turn to four dead chips. Bounded sample instead.
            let _ = session.execute_simple("ROLLBACK").await;
            sampled = true;
            match session.execute_simple(&peek_sample_sql(&path, &col, limit)).await {
                Ok(out) => out,
                Err(e) => {
                    let _ = session.execute_simple("ROLLBACK").await;
                    return Err(e);
                }
            }
        }
        Err(e) => {
            let _ = session.execute_simple("ROLLBACK").await;
            return Err(e);
        }
    };
    let mut values: Vec<String> = out
        .statements
        .get(2)
        .map(|s| {
            s.rows
                .iter()
                .filter_map(|r| r.first().cloned().flatten())
                .collect()
        })
        .unwrap_or_default();
    let more = values.len() > limit as usize;
    values.truncate(limit as usize);
    Ok(PeekResult { values, more, sampled })
}

/// the exact peek: every distinct non-null value, `limit + 1` so `more` is
/// known, under the short exact timeout
fn peek_exact_sql(path: &str, col: &str, limit: u32) -> String {
    format!(
        "BEGIN READ ONLY; SET LOCAL statement_timeout = {PEEK_EXACT_TIMEOUT_MS}; \
         SELECT DISTINCT {col} FROM {path} WHERE {col} IS NOT NULL LIMIT {}; COMMIT",
        limit as u64 + 1,
    )
}

/// the sampled peek: at most `PEEK_SCAN_ROWS` rows from `PEEK_SAMPLE_PCT`
/// percent of the table's pages, then the distinct values among them
fn peek_sample_sql(path: &str, col: &str, limit: u32) -> String {
    format!(
        "BEGIN READ ONLY; SET LOCAL statement_timeout = {PEEK_TIMEOUT_MS}; \
         SELECT DISTINCT {col} FROM (SELECT {col} FROM {path} TABLESAMPLE SYSTEM ({PEEK_SAMPLE_PCT}) \
         WHERE {col} IS NOT NULL LIMIT {PEEK_SCAN_ROWS}) s LIMIT {}; COMMIT",
        limit as u64 + 1,
    )
}

fn is_statement_timeout(e: &DriverError) -> bool {
    e.to_string().contains("statement timeout")
}

/// Run one read-only statement: the gate first (§8.1), then a read-only
/// transaction with `SET LOCAL statement_timeout`. `max_rows` is clamped to
/// `UI_ROW_CAP`. Both a gate refusal and a server error surface as
/// `DriverError::Db`, so the loop's repair path treats them alike.
pub async fn run_readonly(
    session: &PgSession,
    sql: &str,
    max_rows: u32,
    timeout_ms: u64,
) -> Result<AgentRun> {
    let verdict = classify(sql);
    if let Some(reason) = verdict.reason {
        return Err(gate_error(&reason));
    }
    let max_rows = max_rows.min(UI_ROW_CAP) as usize;
    let timeout_ms = timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // the gate proved this is exactly one statement, so a trailing semicolon
    // is punctuation and dropping it keeps the batch's statement count fixed
    let stmt = sql.trim().trim_end_matches(';').trim_end();
    let prefix = format!("BEGIN READ ONLY; SET LOCAL statement_timeout = {timeout_ms}; ");
    // the newline before COMMIT is load-bearing: SQL ending in a `--` comment
    // would otherwise swallow it and leave the transaction open
    let batch = format!("{prefix}{stmt}\n; COMMIT");
    let started = Instant::now();
    let out = match session.execute_simple(&batch).await {
        Ok(out) => out,
        Err(e) => {
            // the explicit BEGIN leaves the session in a failed transaction:
            // end it before the next tool call arrives on this session
            let _ = session.execute_simple("ROLLBACK").await;
            return Err(rebase_position(e, &prefix));
        }
    };
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    // BEGIN, SET, the statement, COMMIT
    let stmt_out = out.statements.get(2).ok_or_else(|| {
        DriverError::Internal(format!(
            "read-only batch returned {} result sets, expected 4",
            out.statements.len()
        ))
    })?;
    let row_count = stmt_out.rows.len() as u64;
    let capped = stmt_out.rows.len() > max_rows;
    let mut rows = stmt_out.rows.clone();
    rows.truncate(max_rows);
    Ok(AgentRun {
        columns: stmt_out.columns.iter().map(|c| c.name.clone()).collect(),
        rows,
        row_count,
        capped,
        ms,
    })
}

/// PG reports an error position as characters into the string it was sent, and
/// what it was sent starts with our transaction prefix. Rebase it onto the
/// model's own SQL, or drop it when it points inside the prefix (nothing the
/// model wrote is to blame there).
fn rebase_position(e: DriverError, prefix: &str) -> DriverError {
    let DriverError::Db { message, position, code, detail, hint } = e else {
        return e;
    };
    let offset = prefix.chars().count() as u32;
    let position = position.and_then(|p| p.checked_sub(offset).filter(|p| *p > 0));
    DriverError::Db { message, position, code, detail, hint }
}

/// Up to `PROBE_MAX` queries, `PROBE_ROW_CAP` rows each. Every query is gated
/// independently; one failure never sinks the batch (its `ProbeResult` carries
/// the error text and the rest still run).
///
/// §5 says probe queries run concurrently. One thread owns ONE session (§2.3)
/// and one PostgreSQL session cannot run two statements at once, so they run in
/// order on that session; at five rows each the latency is a round trip apiece.
pub async fn probe(session: &PgSession, sqls: &[String]) -> Result<Vec<ProbeResult>> {
    if sqls.len() > PROBE_MAX {
        return Err(gate_error(&format!(
            "probe takes at most {PROBE_MAX} queries; {} were asked for",
            sqls.len()
        )));
    }
    let mut results = Vec::with_capacity(sqls.len());
    for sql in sqls {
        let outcome = run_readonly(session, sql, PROBE_ROW_CAP, PROBE_TIMEOUT_MS).await;
        results.push(match outcome {
            Ok(run) => ProbeResult { sql: sql.clone(), run: Some(run), error: None },
            Err(e) => ProbeResult {
                sql: sql.clone(),
                run: None,
                error: Some(first_line(&e.to_string())),
            },
        });
    }
    Ok(results)
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or_default().trim().to_string()
}

fn session_of(state: &AppState, session_id: &str) -> Result<std::sync::Arc<PgSession>> {
    state.session(session_id).ok_or(DriverError::NoSession)
}

// ---- commands -------------------------------------------------------------

/// Open the thread's dedicated PostgreSQL session. Same profile, password and
/// tunnel path as `commands::connect`, plus `force_read_only`: the server
/// starts the session read-only even when the profile is not prod-flagged
/// (§2.3). The session lands in `state.sessions` under a fresh id.
#[tauri::command]
pub async fn agent_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    statement_timeout_ms: Option<u64>,
) -> Result<SessionId> {
    crate::commands::open_session(&app, state.inner(), &profile_id, statement_timeout_ms, true)
        .await
}

/// Low-cardinality `pg_stats` values and comments for the given tables, in ONE
/// round trip for all of them (§5 `describe_tables` is a single turn's worth of
/// context; N round trips would spend the turn's latency).
#[tauri::command]
pub async fn agent_describe(
    state: State<'_, AppState>,
    session_id: String,
    tables: Vec<TableRef>,
) -> Result<Vec<TableValues>> {
    let session = session_of(&state, &session_id)?;
    describe(&session, &tables).await
}

/// Distinct non-null values of one column, `limit` clamped to `PEEK_MAX`,
/// under a 5s `SET LOCAL statement_timeout` so a wide unindexed column cannot
/// spend the turn budget.
#[tauri::command]
pub async fn agent_peek_values(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    column: String,
    limit: u32,
) -> Result<PeekResult> {
    let session = session_of(&state, &session_id)?;
    peek_values(&session, &schema, &table, &column, limit).await
}

/// Run one read-only statement: `classify()` first (§8.1), then a read-only
/// transaction with `SET LOCAL statement_timeout`. `max_rows` is clamped to
/// `UI_ROW_CAP`. A gate refusal and a server error both surface as
/// `DriverError::Db`, so the loop's repair path treats them alike.
#[tauri::command]
pub async fn agent_run_readonly(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: u32,
    timeout_ms: u64,
) -> Result<AgentRun> {
    let session = session_of(&state, &session_id)?;
    run_readonly(&session, &sql, max_rows, timeout_ms).await
}

/// Up to `PROBE_MAX` queries, `PROBE_ROW_CAP` rows each. Every query is gated
/// independently; one failure never sinks the batch (its `ProbeResult` carries
/// the error text and the rest still run).
#[tauri::command]
pub async fn agent_probe(
    state: State<'_, AppState>,
    session_id: String,
    sqls: Vec<String>,
) -> Result<Vec<ProbeResult>> {
    let session = session_of(&state, &session_id)?;
    probe(&session, &sqls).await
}

/// Pure classification, no session and no server round trip: the UI pre-checks
/// a Fix It edit with this before offering to run it.
#[tauri::command]
pub async fn agent_gate(sql: String) -> Result<GateVerdict> {
    Ok(classify(&sql))
}

/// Store a provider API key in the Keychain under `agent:<provider>` (§2.4,
/// §8.3). The key is never returned to TypeScript, only injected into
/// outbound requests by `agent_http.rs`.
#[tauri::command]
pub async fn agent_key_set(provider: String, key: String) -> Result<()> {
    crate::secrets::set_agent_key(&provider, &key)
}

/// Whether a key exists for the provider. Presence only: the value never
/// crosses the IPC boundary.
#[tauri::command]
pub async fn agent_key_has(provider: String) -> Result<bool> {
    crate::secrets::has_agent_key(&provider)
}

#[tauri::command]
pub async fn agent_key_delete(provider: String) -> Result<()> {
    crate::secrets::delete_agent_key(&provider)
}

/// New Ask thread. The id is a server-minted uuid because the `claude -p`
/// provider passes it verbatim as `--session-id` on the thread's first call
/// and `--resume` on every later one (W0 §9).
#[tauri::command]
pub async fn agent_thread_create(
    state: State<'_, AppState>,
    profile_id: String,
    title: String,
) -> Result<AgentThread> {
    let id = uuid::Uuid::new_v4().to_string();
    state.appdb.agent_thread_create(&id, &profile_id, &title)
}

/// This connection's threads, newest first. Threads belong to a connection:
/// switching connections switches threads (AGENT-UX §1).
#[tauri::command]
pub async fn agent_thread_list(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<AgentThread>> {
    state.appdb.agent_threads_list(&profile_id)
}

/// Delete a thread and everything recorded under it (turns and answers).
#[tauri::command]
pub async fn agent_thread_delete(state: State<'_, AppState>, thread_id: String) -> Result<()> {
    state.appdb.agent_thread_delete(&thread_id)
}

/// Delete the turns a cut removed and their answers (W4 jump back / restart),
/// in one transaction. The store names the rows, because write order is not
/// thread order (see `AppDb::agent_thread_truncate`).
#[tauri::command]
pub async fn agent_thread_truncate(
    state: State<'_, AppState>,
    thread_id: String,
    turn_ids: Vec<i64>,
) -> Result<()> {
    state.appdb.agent_thread_truncate(&thread_id, &turn_ids)
}

/// Point a thread at a fresh provider session. A cut calls this because a
/// resumed `claude -p` session remembers the turns the cut deleted.
#[tauri::command]
pub async fn agent_thread_session_set(
    state: State<'_, AppState>,
    thread_id: String,
    session_key: String,
) -> Result<()> {
    state
        .appdb
        .agent_thread_session_set(&thread_id, &session_key)
}

/// Rewrite an assistant turn a re-run answered again (W4 Restart, Fix It, a
/// chip toggle): the row keeps its thread, index and role.
#[tauri::command]
pub async fn agent_turn_update(state: State<'_, AppState>, turn: AgentTurnPatch) -> Result<()> {
    state.appdb.agent_turn_update(&turn)
}

/// Move a thread's turns from `from_idx` up by `by`, freeing the slots a new
/// pair needs between two exchanges (see `AppDb::agent_turns_shift`). The
/// store calls this before the insert, never inside it: a gap is harmless,
/// a collision costs an answer its question.
#[tauri::command]
pub async fn agent_turns_shift(
    state: State<'_, AppState>,
    thread_id: String,
    from_idx: i64,
    by: i64,
) -> Result<()> {
    state.appdb.agent_turns_shift(&thread_id, from_idx, by)
}

/// Append one turn; returns its row id, which `agent_answer_put` keys on.
#[tauri::command]
pub async fn agent_turn_add(state: State<'_, AppState>, turn: AgentTurnInput) -> Result<i64> {
    state.appdb.agent_turn_add(&turn)
}

/// A thread's turns in `idx` order: the trace panel and history read this.
#[tauri::command]
pub async fn agent_turns_list(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<AgentTurn>> {
    state.appdb.agent_turns_list(&thread_id)
}

/// Upsert the answer belonging to a turn (SQL, row count, assumption chips,
/// sanity fragments, verdict status). One answer per turn.
#[tauri::command]
pub async fn agent_answer_put(state: State<'_, AppState>, answer: AgentAnswer) -> Result<()> {
    state.appdb.agent_answer_put(&answer)
}

/// A thread's answers in turn order. Reopening a thread rebuilds its chips,
/// sanity line and row count from these: `agent_turns` holds the conversation,
/// this holds what the conversation concluded.
#[tauri::command]
pub async fn agent_answers_list(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<AgentAnswer>> {
    state.appdb.agent_answers_list(&thread_id)
}

#[cfg(test)]
mod peek_tests {
    use super::{peek_exact_sql, peek_sample_sql};

    #[test]
    fn the_exact_peek_reads_one_more_than_asked_under_the_short_timeout() {
        let sql = peek_exact_sql("\"public\".\"orders\"", "\"status\"", 20);
        assert!(sql.contains("statement_timeout = 2000"));
        assert!(sql.contains("SELECT DISTINCT \"status\" FROM \"public\".\"orders\" WHERE \"status\" IS NOT NULL LIMIT 21"));
    }

    #[test]
    fn the_sampled_peek_is_bounded_by_rows_and_pages() {
        let sql = peek_sample_sql("\"public\".\"videos_store\"", "\"source\"", 20);
        assert!(sql.contains("statement_timeout = 5000"));
        assert!(sql.contains("TABLESAMPLE SYSTEM (0.5)"));
        assert!(sql.contains("LIMIT 20000) s LIMIT 21"));
    }
}

#[cfg(test)]
mod gate_tests {
    use super::{classify, low_cardinality, StatRow};

    fn allowed(sql: &str) -> bool {
        classify(sql).allowed
    }

    fn reason(sql: &str) -> String {
        classify(sql).reason.unwrap_or_default()
    }

    /// the verdict table of w0-pg-query-gate.md §3, case for case
    #[test]
    fn w0_verdict_table() {
        assert!(allowed("SELECT 1;"));
        assert!(allowed("WITH x AS (SELECT 1) SELECT * FROM x;"));
        assert!(allowed("EXPLAIN SELECT 1;"));
        assert!(allowed("EXPLAIN ANALYZE SELECT 1;"));
        assert!(allowed("SELECT nextval('s');")); // read-only layer refuses it
        assert!(allowed("VALUES (1),(2);"));
        assert!(allowed("TABLE t;"));

        assert!(reason("EXPLAIN ANALYZE UPDATE t SET a=1;").contains("EXPLAIN of a UpdateStmt"));
        assert_eq!(
            reason("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d;"),
            "data-modifying CTE (DELETE)"
        );
        assert_eq!(
            reason("SELECT * INTO newt FROM t;"),
            "SELECT INTO / CTAS materializes a new table (write)"
        );
        assert!(reason("CREATE TABLE x AS SELECT 1;").contains("CreateTableAsStmt not allowed"));
        assert_eq!(
            reason("SELECT pg_terminate_backend(1);"),
            "denied function call: pg_terminate_backend()"
        );
        assert_eq!(reason("SELECT pg_sleep(10);"), "denied function call: pg_sleep()");
        assert_eq!(
            reason("SELECT * FROM t FOR UPDATE;"),
            "FOR UPDATE/FOR SHARE takes a row lock"
        );
        assert!(reason("COPY (SELECT 1) TO STDOUT;").contains("CopyStmt not allowed"));
        assert_eq!(
            reason("SELECT 1; SELECT 2;"),
            "2 statements in one call; run_sql takes exactly one"
        );
        assert_eq!(
            reason("SELECT lo_import('/etc/passwd');"),
            "denied function call: lo_import()"
        );
        assert!(reason("SHOW work_mem;").contains("VariableShowStmt not allowed"));
        assert!(reason("SET work_mem='1MB';").contains("VariableSetStmt not allowed"));
        assert!(reason(r"SELECT * FROM t \gset").starts_with("parse error:"));
        assert!(reason("SELECT a syntactically broken query.").starts_with("parse error:"));
    }

    /// W7: prose handed to `run_sql` is told what to do instead, so the model
    /// stops re-sending it. Text that OPENS like a statement stays a parse
    /// error: the model can fix that one.
    #[test]
    fn prose_is_refused_as_prose_and_broken_sql_as_sql() {
        use super::PROSE_REASON;
        assert_eq!(
            reason("I cannot run write queries. Deleting rows is outside what this tool does."),
            PROSE_REASON
        );
        assert_eq!(reason("Here is what I found: nine orders."), PROSE_REASON);
        assert_eq!(reason(""), "empty statement");
        // opens like a statement: a query the model can repair, named as one
        assert!(reason("SELECT FROM").starts_with("parse error:"));
        assert!(reason("  with x as (select").starts_with("parse error:"));
        assert!(reason("(SELECT 1").starts_with("parse error:"));
        assert!(reason("-- a leading comment\nSELECT FROM").starts_with("parse error:"));
        // a write verb keeps the gate's own refusal, which names the kind
        assert!(reason("DELETE FROM t;").contains("DeleteStmt not allowed"));
    }

    /// the refuter's case: `into_clause` / `locking_clause` on a SelectStmt
    /// the structural walk never reaches. Every one of these was ALLOWED by
    /// the W0 draft.
    #[test]
    fn locking_clause_in_every_expression_position() {
        let locked = "FOR UPDATE/FOR SHARE takes a row lock";
        // measured gap: a scalar subquery in the target list
        assert_eq!(
            reason("SELECT (SELECT actor_id FROM actor WHERE actor_id=1 FOR UPDATE)"),
            locked
        );
        assert_eq!(reason("SELECT 1 WHERE 1 = (SELECT 1 FROM t FOR SHARE)"), locked);
        assert_eq!(
            reason("SELECT a FROM t GROUP BY a HAVING count(*) > (SELECT 1 FROM u FOR UPDATE)"),
            locked
        );
        assert_eq!(reason("SELECT a FROM t ORDER BY (SELECT 1 FROM u FOR UPDATE)"), locked);
        assert_eq!(reason("SELECT a FROM t GROUP BY (SELECT 1 FROM u FOR UPDATE)"), locked);
        assert_eq!(
            reason("SELECT CASE WHEN true THEN (SELECT 1 FROM u FOR UPDATE) ELSE 0 END"),
            locked
        );
        assert_eq!(reason("SELECT count((SELECT 1 FROM u FOR UPDATE))"), locked);
        assert_eq!(reason("SELECT 1 LIMIT (SELECT 1 FROM u FOR UPDATE)"), locked);
        assert_eq!(reason("SELECT * FROM (SELECT 1 FROM u FOR UPDATE) x"), locked);
        assert_eq!(
            reason("WITH c AS (SELECT 1 FROM u FOR UPDATE) SELECT * FROM c"),
            locked
        );
        assert_eq!(reason("SELECT 1 UNION SELECT 2 FROM t FOR UPDATE"), locked);
        assert_eq!(reason("EXPLAIN SELECT (SELECT 1 FROM u FOR UPDATE)"), locked);
    }

    #[test]
    fn writes_and_denied_functions_hide_in_subqueries() {
        assert_eq!(
            reason("SELECT * FROM (WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d) x"),
            "data-modifying CTE (DELETE)"
        );
        assert_eq!(
            reason("SELECT 1 WHERE EXISTS (WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i)"),
            "data-modifying CTE (INSERT)"
        );
        // pg_query's own function walk skips LIMIT; the sweep does not
        assert_eq!(
            reason("SELECT 1 LIMIT (SELECT 1 WHERE pg_sleep(10) IS NULL)"),
            "denied function call: pg_sleep()"
        );
        // schema-qualified: the deny-list matches the last dot-segment
        assert_eq!(
            reason("SELECT pg_catalog.pg_sleep(1)"),
            "denied function call: pg_catalog.pg_sleep()"
        );
        assert_eq!(reason("SELECT SET_CONFIG('a','b',false)"), "denied function call: set_config()");
    }

    #[test]
    fn ordinary_analysis_sql_stays_allowed() {
        assert!(allowed(
            "WITH monthly AS (
               SELECT date_trunc('month', r.rental_date) AS m, count(*) AS n
               FROM rental r JOIN inventory i USING (inventory_id)
               WHERE r.rental_date >= '2005-01-01' GROUP BY 1
             )
             SELECT m, n, n::numeric / sum(n) OVER () AS share
             FROM monthly ORDER BY m LIMIT 20"
        ));
        assert!(allowed(
            "SELECT c.name, count(*) FILTER (WHERE f.rating = 'PG') AS pg
             FROM category c LEFT JOIN film_category fc ON fc.category_id = c.category_id
             LEFT JOIN film f USING (film_id) GROUP BY 1 HAVING count(*) > 0"
        ));
        assert!(allowed("SELECT * FROM generate_series(1, 10) AS g(n)"));
    }

    fn stat(n_distinct: f64, reltuples: f64, mcv: &[&str], hist: &[&str]) -> StatRow {
        StatRow {
            schema: "public".into(),
            table: "film".into(),
            column: "rating".into(),
            n_distinct: Some(n_distinct),
            reltuples,
            mcv: Some(mcv.iter().map(|v| Some((*v).to_string())).collect()),
            hist: Some(hist.iter().map(|v| Some((*v).to_string())).collect()),
        }
    }

    #[test]
    fn pgstats_sample_rules() {
        // most_common_vals ∪ histogram_bounds, sorted, de-duplicated
        let (values, more) = low_cardinality(&stat(5.0, 1000.0, &["R", "G"], &["G", "PG"])).unwrap();
        assert_eq!(values, vec!["G", "PG", "R"]);
        assert!(!more);
        // n_distinct < 0 is a FRACTION of the row count: 0.5 * 1000 = 500
        assert!(low_cardinality(&stat(-0.5, 1000.0, &["a"], &[])).is_none());
        // …and the same fraction of a small table is a real category
        assert!(low_cardinality(&stat(-0.5, 42.0, &["a", "b"], &[])).is_none());
        assert!(low_cardinality(&stat(-0.5, 40.0, &["a", "b"], &[])).is_some());
        // over the cap by count
        assert!(low_cardinality(&stat(21.0, 1000.0, &["a"], &[])).is_none());
        // one long value drops the whole column
        let long = "x".repeat(41);
        assert!(low_cardinality(&stat(2.0, 10.0, &[&long], &["b"])).is_none());
        // no sampled values at all
        assert!(low_cardinality(&stat(2.0, 10.0, &[], &[])).is_none());
        // never analyzed: no n_distinct, no values
        let mut unknown = stat(1.0, 10.0, &["a"], &[]);
        unknown.n_distinct = None;
        assert!(low_cardinality(&unknown).is_none());
    }
}
