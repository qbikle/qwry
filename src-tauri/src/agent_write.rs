//! The write dry run (A4 item 3): what a proposed `INSERT` / `UPDATE` /
//! `DELETE` would do, learned by doing it and rolling it back.
//!
//! Nothing here can commit. The statement runs on a SHORT-LIVED session of its
//! own (the connection editor's ephemeral probe, `commands::ephemeral_session`)
//! inside a transaction that ends in `ROLLBACK` on every path, the failing ones
//! included: the rollback is issued in a finally, and the session is dropped
//! the moment the preview is built — dropping it aborts its connection, and it
//! is never registered in `state.sessions`, so no id exists for anything else
//! to run on it.
//!
//! The count the block shows is the count the SERVER reported for the statement
//! itself, never an EXPLAIN estimate (LESSONS 13): the block says `12 rows`
//! because twelve rows were written and then unwritten.
//!
//! Actually running the statement is the user's own act in the active query
//! tab (item 6, `src/stores/results.ts`); nothing in this file ever runs a
//! write that survives.
//!
//! Types here are mirrored by hand in `src/ipc/types.ts` (CLAUDE.md rule);
//! change one, change the other.

use pg_query::protobuf::Node;
use pg_query::NodeEnum;
use serde::Serialize;
use tauri::State;

use crate::agent::{classify_write, gate_error, WriteShape, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS};
use crate::driver::postgres::PgSession;
use crate::driver::{DriverError, ExecOutcome, Result};
use crate::state::AppState;

/// rows carried in each sample: the block's grid window is header plus six
/// rows (`GRID_ROWS_SHOWN`), so the sample is the window and a preview that
/// touched more rows than it shows says so in its count, never by a grid that
/// stops one row short of its own frame. One number, one place to change it.
pub const WRITE_SAMPLE_ROWS: u32 = 6;
/// over this many rows the preview warns (`many_rows`)
pub const MANY_ROWS: u64 = 1_000;

/// UPDATE/DELETE with no WHERE: every row of the table changes
const WARN_MISSING_WHERE: &str = "missing_where";
/// more rows than `MANY_ROWS`
const WARN_MANY_ROWS: &str = "many_rows";

/// The dry run's own error kind, refused before any connection is opened. It
/// rides in `code` because it is not a server error and must not read as one:
/// the UI branches on the code and says it in its own register.
pub const PROD_WRITE_CODE: &str = "QWRY_WRITE_ON_PROD";
/// the code-side sentence; the pane's copy is the UI's, not this one
pub const PROD_WRITE_REASON: &str = "Writes stay off on prod connections.";

/// One sampled grid: wire text, `None` = SQL NULL, exactly like every other
/// result in the app. `before` and `after` carry the same columns in the same
/// order, because `SELECT *` over the statement's own range table and the
/// appended `RETURNING *` expand to the same list — unless the model wrote its
/// OWN `RETURNING`, which is kept as written (§8.4) and names what it names.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SampleRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

/// What one proposed statement would do. `exact_rows` is the server's own
/// count for the statement, not an estimate and not `rows.len()` (LESSONS 13);
/// the samples are at most `WRITE_SAMPLE_ROWS` rows each.
#[derive(Debug, Clone, Serialize)]
pub struct WritePreview {
    pub verb: String,
    pub table: String,
    pub has_where: bool,
    pub exact_rows: u64,
    /// the rows as they stand; empty for an INSERT, which has none
    pub before: SampleRows,
    /// the rows the statement returned; empty for a DELETE, which leaves none
    pub after: SampleRows,
    /// code facts, one token each: `missing_where`, `many_rows`
    pub warnings: Vec<String>,
}

/// The before-sample's SELECT, derived from the parsed statement: the same
/// target relation (and the same extra FROM/USING items, so a correlated WHERE
/// still resolves) under the statement's own WHERE. `SELECT *` over that range
/// table is exactly what `RETURNING *` expands to, so the two samples line up
/// column for column.
///
/// `None` for an INSERT: every row it touches is new, and there is nothing to
/// stand before it. An `Err` is a derivation failure and fails the preview
/// rather than quietly showing an UPDATE as if it were an INSERT (LESSONS 9).
///
/// The statement is parsed a second time here (the gate parsed it first): a
/// parse is microseconds and deterministic, and the alternative is threading a
/// protobuf tree through a public signature no test would want to build.
pub fn before_select(sql: &str, limit: u32) -> std::result::Result<Option<String>, String> {
    let parsed = pg_query::parse(sql).map_err(|e| format!("parse error: {e}"))?;
    let node = parsed
        .protobuf
        .stmts
        .first()
        .and_then(|s| s.stmt.as_ref())
        .and_then(|s| s.node.as_ref())
        .ok_or_else(|| "empty statement".to_string())?;
    let (relation, extra, where_clause) = match node {
        NodeEnum::UpdateStmt(s) => (
            s.relation.clone(),
            s.from_clause.clone(),
            s.where_clause.clone(),
        ),
        NodeEnum::DeleteStmt(s) => (
            s.relation.clone(),
            s.using_clause.clone(),
            s.where_clause.clone(),
        ),
        _ => return Ok(None),
    };
    let relation = relation.ok_or_else(|| "the statement names no table".to_string())?;
    // a parsed template, two fields swapped, deparsed: the LIMIT and the `*`
    // come from the parser rather than from hand-built protobuf nodes
    let template = pg_query::parse(&format!("SELECT * FROM __qwry_target LIMIT {limit}"))
        .map_err(|e| format!("could not derive the before sample: {e}"))?;
    let mut select = match template
        .protobuf
        .stmts
        .first()
        .and_then(|s| s.stmt.as_ref())
        .and_then(|s| s.node.as_ref())
    {
        Some(NodeEnum::SelectStmt(s)) => (**s).clone(),
        _ => return Err("could not derive the before sample".into()),
    };
    select.from_clause = std::iter::once(Node {
        node: Some(NodeEnum::RangeVar(relation)),
    })
    .chain(extra)
    .collect();
    select.where_clause = where_clause;
    NodeEnum::SelectStmt(Box::new(select))
        .deparse()
        .map(Some)
        .map_err(|e| format!("could not derive the before sample: {e}"))
}

/// The statement as the dry run sends it: `RETURNING *` appended when the model
/// wrote none, so the affected rows come back as the after-sample; kept exactly
/// as written when it has one (rewriting the model's own clause would make the
/// trace lie, §8.4). The newline is load-bearing: a statement ending in a `--`
/// comment would otherwise swallow the clause.
pub fn with_returning(sql: &str, has_returning: bool) -> String {
    let stmt = sql.trim().trim_end_matches(';').trim_end();
    if has_returning {
        stmt.to_string()
    } else {
        format!("{stmt}\nRETURNING *")
    }
}

/// The warnings, as code facts: one token each, no sentences (the pane writes
/// those). `missing_where` is the shape's, `many_rows` the dry run's count.
pub fn warnings(shape: &WriteShape, exact_rows: u64) -> Vec<String> {
    let mut out = Vec::new();
    if !shape.has_where && shape.verb != "INSERT" {
        out.push(WARN_MISSING_WHERE.to_string());
    }
    if exact_rows > MANY_ROWS {
        out.push(WARN_MANY_ROWS.to_string());
    }
    out
}

/// The dry run on an open session: gate, derive, run, roll back. The ROLLBACK
/// is the finally — it runs whether the statement succeeded, errored or was
/// never reached — and the caller drops the session straight after.
pub async fn preview_on(
    session: &PgSession,
    sql: &str,
    timeout_ms: u64,
) -> Result<WritePreview> {
    // the gate again, on the session's own doorstep: the loop gates before it
    // gets here, and a gate with a side door is no gate (§8.1)
    let verdict = classify_write(sql);
    let shape = match verdict.write {
        Some(shape) => shape,
        None => {
            return Err(gate_error(
                &verdict.reason.unwrap_or_else(|| "refused".to_string()),
            ))
        }
    };
    let before_sql = before_select(sql, WRITE_SAMPLE_ROWS).map_err(|e| gate_error(&e))?;
    let out = dry_run(session, &shape, before_sql.as_deref(), sql, timeout_ms).await;
    // the finally: nothing this function did outlives it
    let _ = session.execute_simple("ROLLBACK").await;
    out
}

async fn dry_run(
    session: &PgSession,
    shape: &WriteShape,
    before_sql: Option<&str>,
    sql: &str,
    timeout_ms: u64,
) -> Result<WritePreview> {
    let timeout_ms = timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // the before-sample rides the opening message: it is derived SQL, never the
    // model's text, so it carries no comment that could swallow what follows
    let mut open = format!("BEGIN; SET LOCAL statement_timeout = {timeout_ms}");
    if let Some(before) = before_sql {
        open.push_str("; ");
        open.push_str(before);
    }
    let opened = session.execute_simple(&open).await?;
    // BEGIN, SET, then the derived SELECT when there is one
    let before = match before_sql {
        Some(_) => sample(&opened, 2),
        None => SampleRows::default(),
    };

    // the statement alone in its own message: the server's error position then
    // points into the model's own SQL and needs no rebasing
    let written = session
        .execute_simple(&with_returning(sql, shape.has_returning))
        .await?;
    let stmt = written.statements.first().ok_or_else(|| {
        DriverError::Internal("the statement returned no result set".into())
    })?;
    // the command tag, which counts every affected row, not the rows carried
    let exact_rows = stmt.affected.unwrap_or(stmt.rows.len() as u64);
    let after = sample(&written, 0);

    Ok(WritePreview {
        verb: shape.verb.clone(),
        table: shape.table.clone(),
        has_where: shape.has_where,
        exact_rows,
        before,
        after,
        warnings: warnings(shape, exact_rows),
    })
}

fn sample(out: &ExecOutcome, index: usize) -> SampleRows {
    match out.statements.get(index) {
        Some(s) => SampleRows {
            columns: s.columns.iter().map(|c| c.name.clone()).collect(),
            rows: s
                .rows
                .iter()
                .take(WRITE_SAMPLE_ROWS as usize)
                .cloned()
                .collect(),
        },
        None => SampleRows::default(),
    }
}

fn prod_error() -> DriverError {
    DriverError::Db {
        message: PROD_WRITE_REASON.to_string(),
        position: None,
        code: Some(PROD_WRITE_CODE.to_string()),
        detail: None,
        hint: None,
    }
}

// ---- command --------------------------------------------------------------

/// What one proposed statement would do, on a session opened for it and thrown
/// away after. A prod connection is refused BEFORE anything connects: on
/// production the capability does not exist this wave, so the refusal is the
/// dry run's own error kind and not a failed attempt.
#[tauri::command]
pub async fn agent_write_preview(
    state: State<'_, AppState>,
    profile_id: String,
    sql: String,
    timeout_ms: u64,
) -> Result<WritePreview> {
    let profile = state
        .appdb
        .list_profiles()?
        .0
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| DriverError::Internal("no such profile".into()))?;
    if profile.is_prod {
        return Err(prod_error());
    }
    let password = crate::secrets::get_password(&profile_id)?.unwrap_or_default();
    // the session's own statement_timeout as well as the transaction's SET
    // LOCAL: an unregistered session cannot be cancelled, so nothing on it is
    // ever unbounded
    let session = crate::commands::ephemeral_session(
        state.inner(),
        &profile,
        &password,
        Some(timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)),
    )
    .await?;
    preview_on(&session, &sql, timeout_ms).await
}

#[cfg(test)]
mod tests {
    use super::{before_select, warnings, with_returning, WRITE_SAMPLE_ROWS};
    use crate::agent::{classify_write, WriteShape};

    fn derived(sql: &str) -> String {
        before_select(sql, WRITE_SAMPLE_ROWS)
            .expect("derivable")
            .expect("UPDATE and DELETE have a before-sample")
    }

    #[test]
    fn the_before_sample_is_the_target_under_the_statements_own_where() {
        assert_eq!(
            derived("UPDATE order_v2 SET payment_status = 'paid' WHERE id = 218841"),
            "SELECT * FROM order_v2 WHERE id = 218841 LIMIT 6"
        );
        assert_eq!(
            derived(
                "UPDATE order_v2 SET payment_status = 'paid', paid_at = now() \
                 WHERE payment_status = 'pending' AND razorpay_payment_id IS NOT NULL"
            ),
            "SELECT * FROM order_v2 WHERE payment_status = 'pending' AND razorpay_payment_id IS NOT NULL LIMIT 6"
        );
        assert_eq!(
            derived("DELETE FROM notification_history WHERE sent_at < '2026-01-01'"),
            "SELECT * FROM notification_history WHERE sent_at < '2026-01-01' LIMIT 6"
        );
    }

    /// no WHERE is not a failure to derive: the sample is the head of the table,
    /// which is exactly the rows the statement would take
    #[test]
    fn without_a_where_the_sample_is_the_whole_table() {
        assert_eq!(derived("DELETE FROM notification_history"), "SELECT * FROM notification_history LIMIT 6");
        assert_eq!(derived("UPDATE t SET a = 1"), "SELECT * FROM t LIMIT 6");
    }

    #[test]
    fn the_schema_the_alias_and_the_extra_from_items_survive_the_derivation() {
        assert_eq!(
            derived("UPDATE public.order_v2 SET a = 1 WHERE id = 1"),
            "SELECT * FROM public.order_v2 WHERE id = 1 LIMIT 6"
        );
        // the alias the WHERE refers to must still be bound in the derived SELECT
        assert_eq!(
            derived("UPDATE order_v2 AS o SET a = 1 WHERE o.id = 1"),
            "SELECT * FROM order_v2 o WHERE o.id = 1 LIMIT 6"
        );
        // …and so must every relation the WHERE names
        assert_eq!(
            derived("UPDATE t SET a = u.a FROM u WHERE u.id = t.id"),
            "SELECT * FROM t, u WHERE u.id = t.id LIMIT 6"
        );
        assert_eq!(
            derived("DELETE FROM t USING u WHERE u.id = t.id"),
            "SELECT * FROM t, u WHERE u.id = t.id LIMIT 6"
        );
        // a name that needs quoting keeps its quotes
        assert_eq!(
            derived(r#"DELETE FROM "my table" WHERE "id" = 1"#),
            r#"SELECT * FROM "my table" WHERE id = 1 LIMIT 6"#
        );
    }

    #[test]
    fn an_insert_has_no_before_sample() {
        assert_eq!(before_select("INSERT INTO t (a) VALUES (1)", 5), Ok(None));
        assert_eq!(
            before_select("INSERT INTO t (a) SELECT a FROM u WHERE u.n > 0", 5),
            Ok(None)
        );
    }

    #[test]
    fn returning_is_appended_only_when_the_statement_has_none() {
        assert_eq!(
            with_returning("UPDATE t SET a = 1 WHERE id = 2", false),
            "UPDATE t SET a = 1 WHERE id = 2\nRETURNING *"
        );
        // a trailing semicolon is punctuation: the gate proved this is one
        // statement, so dropping it keeps the message's statement count fixed
        assert_eq!(
            with_returning("DELETE FROM t WHERE id = 2;", false),
            "DELETE FROM t WHERE id = 2\nRETURNING *"
        );
        // the newline: a trailing comment would swallow the clause
        assert_eq!(
            with_returning("UPDATE t SET a = 1 -- the paid ones", false),
            "UPDATE t SET a = 1 -- the paid ones\nRETURNING *"
        );
        // the model's own RETURNING is never rewritten
        assert_eq!(
            with_returning("UPDATE t SET a = 1 RETURNING id", true),
            "UPDATE t SET a = 1 RETURNING id"
        );
    }

    fn shape(sql: &str) -> WriteShape {
        classify_write(sql).write.expect("allowed")
    }

    #[test]
    fn the_warnings_are_code_facts() {
        assert_eq!(warnings(&shape("DELETE FROM t"), 48_213), ["missing_where", "many_rows"]);
        assert_eq!(warnings(&shape("DELETE FROM t WHERE id = 1"), 1), Vec::<String>::new());
        assert_eq!(warnings(&shape("UPDATE t SET a = 1"), 12), ["missing_where"]);
        assert_eq!(warnings(&shape("UPDATE t SET a = 1 WHERE id = 1"), 1_001), ["many_rows"]);
        // the boundary is `> 1000`, not `>=`
        assert_eq!(
            warnings(&shape("UPDATE t SET a = 1 WHERE n > 0"), 1_000),
            Vec::<String>::new()
        );
        // an INSERT never wants a WHERE, so it never misses one
        assert_eq!(
            warnings(&shape("INSERT INTO t (a) VALUES (1)"), 3),
            Vec::<String>::new()
        );
    }
}
