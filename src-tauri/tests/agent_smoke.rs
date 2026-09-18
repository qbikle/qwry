//! Live smoke test for the agent's half of the driver (AGENT-SPEC §2.3, §5,
//! §8.1) against a disposable PostgreSQL database you control, never
//! production. Ignored by default; run with:
//!   cargo test --test agent_smoke -- --ignored
//! The lab Postgres the agent research ran on:
//!   QWRY_TEST_HOST=127.0.0.1 QWRY_TEST_PORT=5455 QWRY_TEST_USER=lab \
//!   QWRY_TEST_DB=pagila cargo test --test agent_smoke -- --ignored
//! `QWRY_TEST_PORT` defaults to 5432 (staging_smoke.rs has no port of its own)
//! and `QWRY_TEST_PASSWORD` to empty, which is what a local trust-auth lab
//! instance wants.
//!
//! The assertions below are Pagila's numbers: 1000 films, and an `mpaa_rating`
//! enum with five labels.

use qwry_lib::agent;
use qwry_lib::agent_write;
use qwry_lib::driver::postgres::edit::TableRef;
use qwry_lib::driver::postgres::PgSession;
use qwry_lib::driver::{postgres, DriverError, Profile};

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("missing env {k}"))
}

fn profile() -> Profile {
    Profile {
        id: "agent-test".into(),
        name: "lab".into(),
        host: env("QWRY_TEST_HOST"),
        port: std::env::var("QWRY_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5432),
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        // deliberately NOT prod: force_read_only must hold the session read-only
        // on its own (§2.3)
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    }
}

/// an agent session: what `agent_connect` opens, minus the Tauri state it
/// registers the session in
async fn agent_session() -> PgSession {
    let password = std::env::var("QWRY_TEST_PASSWORD").unwrap_or_default();
    postgres::connect(
        &profile(),
        &password,
        None,
        None,
        None,
        true,
        Box::new(|_, _| {}),
        Box::new(|_| {}),
    )
    .await
    .expect("agent connect")
}

fn table(name: &str) -> TableRef {
    TableRef { schema: "public".into(), name: name.into() }
}

#[tokio::test]
#[ignore]
async fn agent_session_is_read_only_at_the_server() {
    let session = agent_session().await;
    let err = session
        .execute_simple("INSERT INTO film (title, language_id) VALUES ('QWRY TEST', 1)")
        .await
        .expect_err("a write on an agent session must be refused by the server");
    match err {
        DriverError::Db { code, message, .. } => assert_eq!(
            code.as_deref(),
            Some("25006"),
            "expected read_only_sql_transaction, got: {message}"
        ),
        other => panic!("expected a server error, got {other:?}"),
    }
    // the refusal must not have left the session unusable
    let run = agent::run_readonly(&session, "SELECT 1", 10, 10_000)
        .await
        .expect("the session still answers reads");
    assert_eq!(run.rows[0][0].as_deref(), Some("1"));
}

#[tokio::test]
#[ignore]
async fn run_readonly_returns_rows_and_refuses_writes() {
    let session = agent_session().await;
    let run = agent::run_readonly(&session, "SELECT count(*) FROM film", 50, 10_000)
        .await
        .expect("count(*) runs");
    assert_eq!(run.columns, vec!["count"]);
    assert_eq!(run.rows[0][0].as_deref(), Some("1000"));
    assert_eq!(run.row_count, 1);
    assert!(!run.capped);

    // the gate, not the server, is what stops this one (§8.1): EXPLAIN ANALYZE
    // of a write is refused before a round trip happens
    let verdict = agent::classify("EXPLAIN ANALYZE DELETE FROM film");
    assert!(!verdict.allowed, "EXPLAIN ANALYZE of a write must be refused");
    let err = agent::run_readonly(&session, "EXPLAIN ANALYZE DELETE FROM film", 50, 10_000)
        .await
        .expect_err("the gate refuses it");
    assert!(matches!(err, DriverError::Db { .. }), "a refusal wears the shape of a SQL error");

    // …and film is untouched
    let run = agent::run_readonly(&session, "SELECT count(*) FROM film", 50, 10_000)
        .await
        .expect("count(*) runs");
    assert_eq!(run.rows[0][0].as_deref(), Some("1000"));

    // capped: three rows asked for out of more
    let run = agent::run_readonly(&session, "SELECT film_id FROM film ORDER BY 1", 3, 10_000)
        .await
        .expect("capped select runs");
    assert_eq!(run.rows.len(), 3);
    assert!(run.capped);
    assert_eq!(run.row_count, 1000);

    // EXPLAIN is in scope, and SQL ending in a comment must not swallow the
    // COMMIT that closes the read-only transaction
    let run = agent::run_readonly(
        &session,
        "EXPLAIN SELECT count(*) FROM film -- how many?",
        50,
        10_000,
    )
    .await
    .expect("explain runs");
    assert!(!run.rows.is_empty());
    let run = agent::run_readonly(&session, "SELECT 3 -- trailing comment", 10, 10_000)
        .await
        .expect("comment-terminated SQL runs");
    assert_eq!(run.rows[0][0].as_deref(), Some("3"));

    // a server error carries its position rebased onto the model's own SQL,
    // not onto the transaction wrapper we sent it inside
    let err = agent::run_readonly(&session, "SELECT frobnicate(1)", 50, 10_000)
        .await
        .expect_err("unknown function");
    match err {
        DriverError::Db { position, message, .. } => {
            assert_eq!(position, Some(8), "position points at frobnicate: {message}")
        }
        other => panic!("expected a server error, got {other:?}"),
    }
    // …and the failed transaction was rolled back, so the next call works
    let run = agent::run_readonly(&session, "SELECT 2", 10, 10_000)
        .await
        .expect("the session is usable after a failed statement");
    assert_eq!(run.rows[0][0].as_deref(), Some("2"));
}

#[tokio::test]
#[ignore]
async fn describe_carries_enum_values() {
    let session = agent_session().await;
    let described = agent::describe(&session, &[table("film"), table("rental")])
        .await
        .expect("describe");
    assert_eq!(described.len(), 2, "one entry per requested table, in order");
    assert_eq!(described[0].name, "film");
    assert_eq!(described[1].name, "rental");

    let rating = described[0]
        .columns
        .iter()
        .find(|c| c.column == "rating")
        .expect("film.rating carries its values");
    assert_eq!(rating.values.len(), 5, "mpaa_rating has five labels: {rating:?}");
    assert!(!rating.more);
    // title is 1000 distinct strings: not a category, so no values line
    assert!(described[0]
        .columns
        .iter()
        .find(|c| c.column == "title")
        .is_none_or(|c| c.values.is_empty()));

    // a name that is not a table is still answered, with nothing in it: TS can
    // tell "no values to report" from "never came back"
    let described = agent::describe(&session, &[table("no_such_table")])
        .await
        .expect("describe of an unknown table is not an error");
    assert_eq!(described.len(), 1);
    assert!(described[0].columns.is_empty());
}

#[tokio::test]
#[ignore]
async fn peek_values_lists_the_stored_spellings() {
    let session = agent_session().await;
    let peek = agent::peek_values(&session, "public", "film", "rating", 10)
        .await
        .expect("peek");
    assert_eq!(peek.values.len(), 5, "mpaa_rating has five labels: {peek:?}");
    assert!(!peek.more);

    // a short limit tells the model the list is not exhaustive
    let peek = agent::peek_values(&session, "public", "film", "rating", 2)
        .await
        .expect("peek");
    assert_eq!(peek.values.len(), 2);
    assert!(peek.more);

    // a wrong column name comes back as the list of real ones
    let err = agent::peek_values(&session, "public", "film", "raiting", 10)
        .await
        .expect_err("unknown column");
    let msg = err.to_string();
    assert!(msg.contains("no column \"raiting\""), "{msg}");
    assert!(msg.contains("rating"), "the real columns are listed: {msg}");
}

#[tokio::test]
#[ignore]
async fn probe_runs_each_query_independently() {
    let session = agent_session().await;
    let sqls = vec![
        "SELECT min(rental_date), max(rental_date) FROM rental".to_string(),
        "SELECT count(*) FROM payment WHERE amount < 0".to_string(),
    ];
    let results = agent::probe(&session, &sqls).await.expect("probe");
    assert_eq!(results.len(), 2);
    for r in &results {
        assert!(r.error.is_none(), "{r:?}");
        let run = r.run.as_ref().expect("every probe ran");
        assert!(!run.rows.is_empty());
    }

    // neither a gate refusal nor a server error sinks the batch: the queries
    // after them still run on the same session
    let sqls = vec![
        "DELETE FROM film".to_string(),
        "SELECT * FROM no_such_table".to_string(),
        "SELECT 1".to_string(),
    ];
    let results = agent::probe(&session, &sqls).await.expect("probe");
    assert_eq!(results.len(), 3);
    for refused in &results[..2] {
        assert!(refused.run.is_none());
        let error = refused.error.as_deref().expect("carries the reason");
        assert!(!error.is_empty());
        assert!(!error.contains('\n'), "first line only: {error}");
    }
    assert_eq!(
        results[2].run.as_ref().expect("the last one still ran").rows[0][0].as_deref(),
        Some("1")
    );
}

// ---- A4 item 3: the write dry run -----------------------------------------

/// what `agent_write_preview` opens for the dry run: an ordinary session, NOT
/// read-only (the transaction's `ROLLBACK` is what makes it safe), never
/// registered anywhere, dropped when the test ends
async fn write_session() -> PgSession {
    let password = std::env::var("QWRY_TEST_PASSWORD").unwrap_or_default();
    postgres::connect(
        &profile(),
        &password,
        None,
        None,
        Some(10_000),
        false,
        Box::new(|_, _| {}),
        Box::new(|_| {}),
    )
    .await
    .expect("write connect")
}

async fn one_value(session: &PgSession, sql: &str) -> String {
    let out = session.execute_simple(sql).await.expect("read back");
    out.statements
        .first()
        .and_then(|s| s.rows.first())
        .and_then(|r| r.first().cloned().flatten())
        .expect("one value")
}

/// the dry run measures by doing, and the doing does not survive it
#[tokio::test]
#[ignore]
async fn write_preview_counts_an_update_and_rolls_it_back() {
    let session = write_session().await;
    let before_run =
        one_value(&session, "SELECT rental_rate FROM film WHERE film_id = 1").await;

    let preview = agent_write::preview_on(
        &session,
        "UPDATE film SET rental_rate = rental_rate + 1 WHERE film_id <= 3",
        10_000,
    )
    .await
    .expect("the preview runs");

    assert_eq!(preview.verb, "UPDATE");
    assert_eq!(preview.table, "film");
    assert!(preview.has_where);
    // the SERVER's count for the statement, not the sample's length (LESSONS 13)
    assert_eq!(preview.exact_rows, 3);
    assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);
    // both samples carry the same columns, so one grid can read old → new
    assert_eq!(preview.before.columns, preview.after.columns);
    assert_eq!(preview.before.rows.len(), 3);
    assert_eq!(preview.after.rows.len(), 3);
    let rate = preview
        .before
        .columns
        .iter()
        .position(|c| c == "rental_rate")
        .expect("film has a rental_rate");
    assert_eq!(preview.before.rows[0][rate].as_deref(), Some(before_run.as_str()));
    assert_ne!(preview.after.rows[0][rate], preview.before.rows[0][rate]);

    // …and the row is exactly as it was, on this session and on a fresh one
    assert_eq!(
        one_value(&session, "SELECT rental_rate FROM film WHERE film_id = 1").await,
        before_run
    );
    let after = write_session().await;
    assert_eq!(
        one_value(&after, "SELECT rental_rate FROM film WHERE film_id = 1").await,
        before_run
    );
}

/// a DELETE with no WHERE: both warnings, the before-sample capped at five, and
/// every row still there afterwards
#[tokio::test]
#[ignore]
async fn write_preview_warns_on_a_delete_that_names_no_rows() {
    let session = write_session().await;
    let before_count = one_value(&session, "SELECT count(*) FROM film_actor").await;

    let preview = agent_write::preview_on(&session, "DELETE FROM film_actor", 30_000)
        .await
        .expect("the preview runs");

    assert_eq!(preview.verb, "DELETE");
    assert!(!preview.has_where);
    assert_eq!(preview.exact_rows.to_string(), before_count);
    assert_eq!(preview.warnings, ["missing_where", "many_rows"]);
    assert_eq!(preview.before.rows.len(), 5, "the sample is capped");
    assert_eq!(preview.after.rows.len(), 5);

    assert_eq!(
        one_value(&session, "SELECT count(*) FROM film_actor").await,
        before_count
    );
}

/// an INSERT has no before-sample, and a refusal still leaves the session clean
#[tokio::test]
#[ignore]
async fn write_preview_on_an_insert_and_on_a_statement_the_gate_refuses() {
    let session = write_session().await;
    let preview = agent_write::preview_on(
        &session,
        "INSERT INTO actor (first_name, last_name) VALUES ('QWRY', 'TEST')",
        10_000,
    )
    .await
    .expect("the preview runs");
    assert_eq!(preview.verb, "INSERT");
    assert_eq!(preview.exact_rows, 1);
    assert!(preview.before.rows.is_empty(), "an INSERT has nothing before it");
    assert!(preview.before.columns.is_empty());
    assert_eq!(preview.after.rows.len(), 1);
    assert_eq!(
        one_value(
            &session,
            "SELECT count(*) FROM actor WHERE first_name = 'QWRY'"
        )
        .await,
        "0",
        "the inserted row was rolled back"
    );

    // the gate refuses before anything runs, and the session still answers
    let err = agent_write::preview_on(&session, "TRUNCATE film", 10_000)
        .await
        .expect_err("TRUNCATE is not one of the three verbs");
    assert!(err.to_string().contains("TruncateStmt not allowed"), "{err}");
    assert_eq!(one_value(&session, "SELECT 1").await, "1");
}
