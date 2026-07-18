//! Live smoke test against the user's staging DB. Ignored by default; run with:
//!   source ~/.claude/.env.claude && cargo test --test staging_smoke -- --ignored
//! using QWRY_TEST_HOST/USER/PASSWORD/DB env vars.

use qwry_lib::driver::{postgres, Profile};

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("missing env {k}"))
}

#[tokio::test]
#[ignore]
async fn staging_connect_and_query() {
    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    // single select
    let out = session
        .execute_simple("SELECT 1 AS one, 'héllo' AS txt, NULL AS nil, now()")
        .await
        .expect("execute");
    assert_eq!(out.statements.len(), 1);
    let stmt = &out.statements[0];
    assert_eq!(
        stmt.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["one", "txt", "nil", "now"]
    );
    assert_eq!(stmt.rows[0][0].as_deref(), Some("1"));
    assert_eq!(stmt.rows[0][1].as_deref(), Some("héllo"));
    assert_eq!(stmt.rows[0][2], None);

    // multi-statement
    let out = session
        .execute_simple("SELECT 1; SELECT 2 AS b; SELECT jsonb_build_object('k', 1)")
        .await
        .expect("multi");
    assert_eq!(out.statements.len(), 3);
    assert_eq!(out.statements[2].rows[0][0].as_deref(), Some(r#"{"k": 1}"#));

    // real table + error path
    let out = session
        .execute_simple("SELECT * FROM pg_tables LIMIT 5")
        .await
        .expect("pg_tables");
    assert_eq!(out.statements[0].rows.len(), 5);

    let err = session
        .execute_simple("SELEC oops")
        .await
        .expect_err("syntax error expected");
    let msg = format!("{err}");
    assert!(msg.contains("syntax"), "unexpected error: {msg}");
}

#[tokio::test]
#[ignore]
async fn staging_introspect() {
    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    let start = std::time::Instant::now();
    let snap = session.introspect().await.expect("introspect");
    let ms = start.elapsed().as_millis();

    assert!(snap.schemas.contains(&"public".to_string()));
    assert!(!snap.tables.is_empty(), "no tables found");
    let with_pk = snap
        .tables
        .iter()
        .find(|t| t.schema == "public" && t.kind == "r" && !t.pk.is_empty())
        .expect("no table with a primary key found");
    assert!(!with_pk.columns.is_empty());
    assert!(
        snap.functions.iter().any(|f| f.name == "jsonb_build_object"),
        "builtin functions missing"
    );
    println!(
        "introspect: {} tables, {} fks, {} functions in {}ms",
        snap.tables.len(),
        snap.foreign_keys.len(),
        snap.functions.len(),
        ms
    );
}

#[tokio::test]
#[ignore]
async fn staging_edit_pipeline() {
    use qwry_lib::driver::postgres::edit::RowEdit;

    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    session
        .execute_simple(
            "DROP TABLE IF EXISTS qwry_edit_test;
             CREATE TABLE qwry_edit_test (id serial PRIMARY KEY, name text, val int);
             INSERT INTO qwry_edit_test (name, val) VALUES ('a', 1), ('b', 2), ('c', NULL)",
        )
        .await
        .expect("setup");

    // editability: computed col read-only, base cols editable
    let sql = "SELECT id, name, val, upper(name) AS un FROM qwry_edit_test ORDER BY id";
    let map = session.editability(sql, 0, None).await.expect("editability");
    assert!(map.columns[0].editable, "id should be editable");
    assert!(map.columns[1].editable, "name should be editable");
    assert!(map.columns[2].editable, "val should be editable");
    assert!(!map.columns[3].editable, "computed col must be read-only");
    assert!(map.columns[3].reason.as_deref().unwrap().contains("computed"));

    // no PK in selection → read-only with actionable reason
    let map2 = session
        .editability("SELECT name FROM qwry_edit_test", 0, None)
        .await
        .expect("editability2");
    assert!(!map2.columns[0].editable);
    assert!(map2.columns[0].reason.as_deref().unwrap().contains("primary key"));

    // preview generates sane SQL
    let oid = map.columns[0].table_oid;
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("edited".into()), use_default: false, pk: vec![(0, Some("2".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 2, value: None, use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] },
    ];
    let preview = session
        .build_edit_statements(sql, 0, &edits, None)
        .await
        .expect("preview");
    assert_eq!(preview.len(), 2);
    assert!(preview[0].contains(r#"SET "name" = 'edited'::text WHERE "id" = '2'::int4"#), "{}", preview[0]);
    assert!(preview[1].contains(r#"SET "val" = NULL"#), "{}", preview[1]);

    // apply in one tx, RETURNING refreshes
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply");
    assert!(outcome.committed);
    assert!(outcome.results.iter().all(|r| r.ok), "{:?}", outcome.results);
    assert_eq!(outcome.results[0].new_value.as_deref(), Some("edited"));

    let check = session
        .execute_simple("SELECT name, val FROM qwry_edit_test ORDER BY id")
        .await
        .expect("check");
    assert_eq!(check.statements[0].rows[1][0].as_deref(), Some("edited"));
    assert_eq!(check.statements[0].rows[0][1], None, "val should be NULL");

    // edit through a JOIN: base-table column still editable
    let join_sql = "SELECT t.id, t.name, o.name AS other FROM qwry_edit_test t JOIN qwry_edit_test o ON o.id = t.id";
    let jmap = session.editability(join_sql, 0, None).await.expect("join map");
    assert!(jmap.columns[1].editable, "joined base col should be editable");

    session
        .execute_simple("DROP TABLE qwry_edit_test")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore]
async fn staging_matched_rollback() {
    use qwry_lib::driver::postgres::edit::RowEdit;

    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    session
        .execute_simple(
            "DROP TABLE IF EXISTS qwry_rb_test;
             CREATE TABLE qwry_rb_test (id int PRIMARY KEY, v text);
             INSERT INTO qwry_rb_test VALUES (1, 'one'), (2, 'two')",
        )
        .await
        .expect("setup");

    let sql = "SELECT id, v FROM qwry_rb_test ORDER BY id";
    let map = session.editability(sql, 0, None).await.expect("map");
    let oid = map.columns[0].table_oid;

    // one valid edit + one stale locator (id=99 matches 0 rows) → whole batch
    // must roll back; previously this COMMITTED and reported committed:true
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("changed".into()), use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 1, value: Some("ghost".into()), use_default: false, pk: vec![(0, Some("99".into()))], guard: vec![] },
    ];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply");
    assert!(!outcome.committed, "mismatch must not commit");
    assert!(outcome.results.iter().all(|r| !r.ok), "{:?}", outcome.results);
    let check = session
        .execute_simple("SELECT v FROM qwry_rb_test WHERE id = 1")
        .await
        .expect("check");
    assert_eq!(
        check.statements[0].rows[0][0].as_deref(),
        Some("one"),
        "valid edit must be rolled back with the batch"
    );

    // the same valid edit alone commits fine
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 1,
        value: Some("changed".into()),
        use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply2");
    assert!(outcome.committed);
    assert!(outcome.results[0].ok);
    assert_eq!(outcome.results[0].new_value.as_deref(), Some("changed"));

    // delete: one valid + one stale locator → rolled back, both rows survive
    let outcome = session
        .delete_rows(sql, 0, oid, vec![
            vec![(0, Some("2".into()))],
            vec![(0, Some("99".into()))],
        ], None)
        .await
        .expect("delete");
    assert!(!outcome.committed, "mismatched delete must not commit");
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_rb_test")
        .await
        .expect("check2");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("2"), "no row may be deleted");

    // valid single delete commits
    let outcome = session
        .delete_rows(sql, 0, oid, vec![vec![(0, Some("2".into()))]], None)
        .await
        .expect("delete2");
    assert!(outcome.committed);

    // SET DEFAULT: use_default writes the column default, not NULL
    session
        .execute_simple("ALTER TABLE qwry_rb_test ALTER COLUMN v SET DEFAULT 'dflt'")
        .await
        .expect("alter default");
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 1,
        value: None,
        use_default: true,
        pk: vec![(0, Some("1".into()))], guard: vec![],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("default apply");
    assert!(outcome.committed);
    assert_eq!(
        outcome.results[0].new_value.as_deref(),
        Some("dflt"),
        "SET DEFAULT must write the column default"
    );

    session
        .execute_simple("DROP TABLE qwry_rb_test")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore]
async fn staging_statement_at_a_time() {
    use qwry_lib::driver::QueryEvent;

    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    session
        .execute_simple(
            "DROP TABLE IF EXISTS qwry_stmt_test;
             CREATE TABLE qwry_stmt_test (id int PRIMARY KEY, v text)",
        )
        .await
        .expect("setup");

    // 1) autocommit semantics: a statement before an error REALLY committed —
    //    the old whole-buffer implicit transaction would have rolled it back
    let buffer = "INSERT INTO qwry_stmt_test VALUES (1, 'kept'); SELEC oops";
    let mut events: Vec<QueryEvent> = Vec::new();
    let mut sink = |ev: QueryEvent| {
        events.push(ev);
        true
    };
    let res = session.execute_stream(buffer, &mut sink).await;
    assert!(res.is_err(), "syntax error must fail the run");
    let (err_index, err_pos) = events
        .iter()
        .find_map(|e| match e {
            QueryEvent::Error { index, position, .. } => Some((*index, *position)),
            _ => None,
        })
        .expect("error event");
    assert_eq!(err_index, 1, "error belongs to statement 2");
    let stmt2_off = "INSERT INTO qwry_stmt_test VALUES (1, 'kept'); ".chars().count() as u32;
    assert_eq!(
        err_pos.expect("position"),
        stmt2_off + 1,
        "position rebased onto the whole buffer"
    );
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_stmt_test")
        .await
        .expect("check");
    assert_eq!(
        check.statements[0].rows[0][0].as_deref(),
        Some("1"),
        "INSERT before the error must be committed"
    );

    // 2) tx-block-refusing statements now work in multi-statement buffers
    let mut sink = |_ev: QueryEvent| true;
    session
        .execute_stream("VACUUM qwry_stmt_test; SELECT 1", &mut sink)
        .await
        .expect("VACUUM in a multi-statement buffer");

    // 3) explicit transactions still span statements (same session)
    session
        .execute_stream(
            "BEGIN; INSERT INTO qwry_stmt_test VALUES (2, 'rolled'); ROLLBACK",
            &mut sink,
        )
        .await
        .expect("explicit tx");
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_stmt_test")
        .await
        .expect("check2");
    assert_eq!(
        check.statements[0].rows[0][0].as_deref(),
        Some("1"),
        "ROLLBACK must undo the INSERT"
    );

    // 4) non-rowset statements start BEFORE they finish and report real ms
    let mut events: Vec<QueryEvent> = Vec::new();
    let mut sink = |ev: QueryEvent| {
        events.push(ev);
        true
    };
    session
        .execute_stream("DO $x$ BEGIN PERFORM pg_sleep(0.2); END $x$; SELECT 1", &mut sink)
        .await
        .expect("do block");
    let start0 = events
        .iter()
        .position(|e| matches!(e, QueryEvent::StatementStart { index: 0, .. }))
        .expect("start event");
    let done0 = events
        .iter()
        .position(|e| matches!(e, QueryEvent::StatementDone { index: 0, .. }))
        .expect("done event");
    assert!(start0 < done0, "statement starts before it completes");
    let ms = events
        .iter()
        .find_map(|e| match e {
            QueryEvent::StatementDone { index: 0, ms, .. } => Some(*ms),
            _ => None,
        })
        .unwrap();
    assert!(ms >= 150.0, "DO-block duration should be real, got {ms}ms");

    session
        .execute_simple("DROP TABLE qwry_stmt_test")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore]
async fn staging_streaming_and_cancel() {
    use qwry_lib::driver::QueryEvent;
    use std::sync::Arc;

    let profile = Profile {
        id: "test".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    // streaming: 120k rows → capped at 50k sent, full count reported, batches ≤500
    let mut events: Vec<QueryEvent> = Vec::new();
    let mut sink = |ev: QueryEvent| {
        events.push(ev);
        true
    };
    session
        .execute_stream(
            "SELECT generate_series(1, 120000) AS n; SELECT 'two' AS t",
            &mut sink,
        )
        .await
        .expect("stream");

    let mut sent_rows = 0u64;
    let mut dones = Vec::new();
    for ev in &events {
        match ev {
            QueryEvent::Rows { index: 0, rows, .. } => {
                assert!(rows.len() <= 500);
                sent_rows += rows.len() as u64;
            }
            QueryEvent::StatementDone { index, row_count, capped, .. } => {
                dones.push((*index, *row_count, *capped));
            }
            _ => {}
        }
    }
    assert_eq!(sent_rows, 50_000, "cap should limit sent rows");
    assert_eq!(dones[0], (0, 120_000, true));
    assert_eq!(dones[1].0, 1);
    assert!(matches!(events.last(), Some(QueryEvent::Finished { .. })));

    // ROW_CAP auto-cancel: a capped SELECT as the LAST statement must complete
    // WITHOUT error (the driver cancels its own drain and swallows the 57014).
    // pg_sleep per row keeps the query genuinely running so the cancel lands —
    // with instant queries the cancel legitimately races and the full drain
    // completes normally (both paths are valid; both must return Ok+capped).
    let mut events: Vec<QueryEvent> = Vec::new();
    let mut sink = |ev: QueryEvent| {
        events.push(ev);
        true
    };
    session
        .execute_stream(
            "SELECT n, pg_sleep(0.00005) FROM generate_series(1, 200000) n",
            &mut sink,
        )
        .await
        .expect("auto-cancelled capped select must not error");
    let done = events
        .iter()
        .find_map(|e| match e {
            QueryEvent::StatementDone { row_count, capped, .. } => Some((*row_count, *capped)),
            _ => None,
        })
        .expect("statement_done");
    assert!(done.1, "must report capped");
    assert!(done.0 >= 50_000, "row_count counts at least the cap, got {}", done.0);
    assert!(
        done.0 < 200_000,
        "auto-cancel should stop the drain early, got {}",
        done.0
    );
    assert!(matches!(events.last(), Some(QueryEvent::Finished { .. })));

    // cancellation: long pg_sleep killed from another task
    let session = Arc::new(session);
    let s2 = session.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        s2.cancel().await.expect("cancel");
    });
    let start = std::time::Instant::now();
    let mut sink = |_ev: QueryEvent| true;
    let res = session.execute_stream("SELECT pg_sleep(30)", &mut sink).await;
    canceller.await.unwrap();
    assert!(start.elapsed().as_secs() < 5, "cancel should kill quickly");
    let msg = format!("{}", res.expect_err("expected cancel error"));
    assert!(
        msg.contains("cancel") || msg.contains("statement"),
        "unexpected: {msg}"
    );
}

/// prod safe-mode: an is_prod profile's session starts server-side read-only —
/// writes error until the per-session unlock, and re-lock restores the guard
#[tokio::test]
#[ignore]
async fn staging_prod_read_only() {
    let profile = Profile {
        id: "test-prod-ro".into(),
        name: "staging-as-prod".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: true, // the flag under test
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    // reads fine
    session.execute_simple("SELECT 1").await.expect("read");

    // any write is refused AT THE SERVER (sqlstate 25006)
    let err = session
        .execute_simple("CREATE TEMP TABLE qwry_ro_probe(x int)")
        .await
        .expect_err("write must be blocked");
    let msg = format!("{err:?}").to_lowercase();
    assert!(msg.contains("read-only"), "expected read-only error, got: {msg}");

    // per-session unlock lifts it…
    session
        .execute_simple("SET default_transaction_read_only = off")
        .await
        .expect("unlock");
    session
        .execute_simple("CREATE TEMP TABLE qwry_ro_probe(x int)")
        .await
        .expect("write after unlock");

    // …and re-lock restores the guard
    session
        .execute_simple("SET default_transaction_read_only = on")
        .await
        .expect("relock");
    // NB: INSERT into an EXISTING temp table is allowed in a read-only txn
    // (per PG semantics) — probe with CREATE TEMP, which is not
    let err = session
        .execute_simple("CREATE TEMP TABLE qwry_ro_probe2(x int)")
        .await
        .expect_err("write must be blocked again");
    let msg = format!("{err:?}").to_lowercase();
    assert!(msg.contains("read-only"), "expected read-only error after relock, got: {msg}");
}

/// DDL reconstruction — sanity: CREATE TABLE with columns, PK constraint,
/// secondary indexes come back for a real staging table
#[tokio::test]
#[ignore]
async fn staging_table_ddl() {
    let profile = Profile {
        id: "test-ddl".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");
    let ddl = session
        .table_ddl("public", "product_videos")
        .await
        .expect("ddl");
    println!("{ddl}");
    assert!(ddl.starts_with("CREATE TABLE \"public\".\"product_videos\" ("));
    assert!(ddl.to_lowercase().contains("primary key"), "PK missing:\n{ddl}");
}

/// Perf-batch A/B: batched verify-then-commit + the cached-mapping (hint)
/// feed. Proves: (1) hint-fed editability == derived; (2) preview SQL with a
/// hint is byte-identical to derived preview; (3) a multi-row edit commits
/// through the batched path with per-row verification; (4) a deliberately
/// STALE mapping (wrong column name) errors and rolls back EVERYTHING — no
/// partial writes; (5) a stale PK locator under a hint → matched≠1 → full
/// rollback; (6) delete_rows batched path (mixed stale → rollback; valid →
/// commit).
#[tokio::test]
#[ignore]
async fn staging_batched_and_hinted_paths() {
    use qwry_lib::driver::postgres::edit::{
        ColumnMapHint, EditMapHint, RowEdit, TableIdentityHint,
    };

    let profile = Profile {
        id: "test-hint".into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: env("QWRY_TEST_DB"),
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"), None, None, Box::new(|_, _| {}), Box::new(|_| {}))
        .await
        .expect("connect");

    session
        .execute_simple(
            "DROP TABLE IF EXISTS qwry_hint_test;
             CREATE TABLE qwry_hint_test (id int PRIMARY KEY, a text, b int);
             INSERT INTO qwry_hint_test VALUES (1, 'one', 10), (2, 'two', 20), (3, 'three', 30)",
        )
        .await
        .expect("setup");

    let sql = "SELECT id, a, b FROM qwry_hint_test ORDER BY id";
    let derived = session.editability(sql, 0, None).await.expect("derived map");
    let oid = derived.columns[0].table_oid;

    // (1) hint-fed editability must equal the derived map
    let identity = vec![TableIdentityHint {
        table_oid: oid,
        schema: "public".into(),
        name: "qwry_hint_test".into(),
        pk_attnums: vec![1],
        relkind: "r".into(),
        generated_attnums: vec![],
        identity_always_attnums: vec![],
    }];
    let hinted = session
        .editability(sql, 0, Some(&identity))
        .await
        .expect("hinted map");
    assert_eq!(hinted.tables, derived.tables, "hinted table names must match derived");
    assert_eq!(hinted.pk_cols, derived.pk_cols, "hinted pk_cols must match derived");
    for (h, d) in hinted.columns.iter().zip(derived.columns.iter()) {
        assert_eq!(h.editable, d.editable, "editable flag diverged on col {}", d.col);
        assert_eq!(h.type_name, d.type_name);
        assert_eq!(h.attnum, d.attnum);
    }

    // full plan-path hint: derived map + real column names by attnum
    let name_of = |att: i16| -> Option<String> {
        match att {
            1 => Some("id".into()),
            2 => Some("a".into()),
            3 => Some("b".into()),
            _ => None,
        }
    };
    let mk_hint = |names: &dyn Fn(i16) -> Option<String>| EditMapHint {
        columns: derived
            .columns
            .iter()
            .map(|c| ColumnMapHint {
                col: c.col,
                table_oid: c.table_oid,
                attnum: c.attnum,
                editable: c.editable,
                type_name: c.type_name.clone(),
                cast: Some(c.cast.clone()),
                is_ctid: c.is_ctid,
                name: names(c.attnum),
            })
            .collect(),
        pk_cols: derived.pk_cols.clone(),
        table_refs: derived.table_refs.clone(),
    };
    let good_hint = mk_hint(&name_of);

    // (2) preview: hint path byte-identical to the derived path
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("uno".into()), use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 2, value: Some("11".into()), use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 1, value: Some("dos".into()), use_default: false, pk: vec![(0, Some("2".into()))], guard: vec![] },
    ];
    let p_derived = session
        .build_edit_statements(sql, 0, &edits, None)
        .await
        .expect("derived preview");
    let p_hinted = session
        .build_edit_statements(sql, 0, &edits, Some(good_hint.clone()))
        .await
        .expect("hinted preview");
    assert_eq!(p_hinted, p_derived, "hinted preview must be byte-identical to derived");

    // (3) multi-row commit via the batched path, per-row verification
    let outcome = session
        .apply_edits(sql, 0, edits.clone(), Some(good_hint.clone()))
        .await
        .expect("hinted apply");
    assert!(outcome.committed, "batched hinted commit must succeed");
    assert!(outcome.results.iter().all(|r| r.ok), "{:?}", outcome.results);
    assert_eq!(outcome.results[0].new_value.as_deref(), Some("uno"));
    assert_eq!(outcome.results[1].new_value.as_deref(), Some("11"));
    assert_eq!(outcome.results[2].new_value.as_deref(), Some("dos"));
    let check = session
        .execute_simple("SELECT a, b FROM qwry_hint_test ORDER BY id")
        .await
        .expect("check");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("uno"));
    assert_eq!(check.statements[0].rows[0][1].as_deref(), Some("11"));
    assert_eq!(check.statements[0].rows[1][0].as_deref(), Some("dos"));

    // (4) STALE mapping: column 'a' renamed to a nonexistent name in the hint.
    // The generated UPDATE hits 42703; the whole batch (including the row that
    // would have succeeded) must roll back — zero partial writes.
    let stale_names = |att: i16| -> Option<String> {
        match att {
            1 => Some("id".into()),
            2 => Some("zzz_qwry_gone".into()), // deliberately wrong
            3 => Some("b".into()),
            _ => None,
        }
    };
    let stale_hint = mk_hint(&stale_names);
    let edits = vec![
        RowEdit { table_oid: oid, col: 2, value: Some("999".into()), use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] }, // valid column (b)
        RowEdit { table_oid: oid, col: 1, value: Some("ghost".into()), use_default: false, pk: vec![(0, Some("2".into()))], guard: vec![] }, // stale-named column
    ];
    let err = session
        .apply_edits(sql, 0, edits, Some(stale_hint))
        .await
        .expect_err("stale mapping must error");
    let msg = format!("{err:?}").to_lowercase();
    assert!(msg.contains("zzz_qwry_gone"), "error should name the missing column: {msg}");
    let check = session
        .execute_simple("SELECT a, b FROM qwry_hint_test WHERE id IN (1,2) ORDER BY id")
        .await
        .expect("check2");
    assert_eq!(check.statements[0].rows[0][1].as_deref(), Some("11"), "valid row's write must be rolled back");
    assert_eq!(check.statements[0].rows[1][0].as_deref(), Some("dos"), "no partial writes");
    // the session must be usable again (aborted tx was rolled back)
    session.execute_simple("SELECT 1").await.expect("session usable after rollback");

    // (5) stale PK locator under a good hint → matched≠1 → full rollback
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("kept?".into()), use_default: false, pk: vec![(0, Some("1".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 1, value: Some("ghost".into()), use_default: false, pk: vec![(0, Some("99".into()))], guard: vec![] },
    ];
    let outcome = session
        .apply_edits(sql, 0, edits, Some(good_hint.clone()))
        .await
        .expect("apply");
    assert!(!outcome.committed, "matched≠1 must roll the hinted batch back");
    assert!(outcome.results.iter().all(|r| !r.ok));
    let check = session
        .execute_simple("SELECT a FROM qwry_hint_test WHERE id = 1")
        .await
        .expect("check3");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("uno"), "no row may change");

    // (6) delete_rows batched path: mixed valid+stale → rollback, both survive
    let outcome = session
        .delete_rows(sql, 0, oid, vec![
            vec![(0, Some("3".into()))],
            vec![(0, Some("99".into()))],
        ], Some(good_hint.clone()))
        .await
        .expect("delete");
    assert!(!outcome.committed, "mismatched hinted delete must not commit");
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_hint_test")
        .await
        .expect("check4");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("3"), "no row may be deleted");
    // …and a valid batched delete of TWO rows commits with per-row results
    let outcome = session
        .delete_rows(sql, 0, oid, vec![
            vec![(0, Some("2".into()))],
            vec![(0, Some("3".into()))],
        ], Some(good_hint))
        .await
        .expect("delete2");
    assert!(outcome.committed);
    assert_eq!(outcome.results.len(), 2);
    assert!(outcome.results.iter().all(|r| r.ok));
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_hint_test")
        .await
        .expect("check5");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("1"));

    session
        .execute_simple("DROP TABLE qwry_hint_test")
        .await
        .expect("cleanup");
}

// ---------------------------------------------------------------------------
// v0.7.0-bedrock additions. Fixture-creating tests run against a SECOND
// staging db (QWRY_TEST_DB2, default "squad") inside a dedicated qwry_test
// schema — never public. Fixtures are dropped at each test's end.
// ---------------------------------------------------------------------------

fn db2() -> String {
    std::env::var("QWRY_TEST_DB2").unwrap_or_else(|_| "squad".into())
}

fn test_profile(id: &str, dbname: String) -> Profile {
    Profile {
        id: id.into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname,
        user: env("QWRY_TEST_USER"),
        sslmode: "prefer".into(),
        color: None,
        glyph: None,
        is_prod: false,
        ssh_host: None,
        ssh_port: None,
        ssh_user: None,
        ssh_key: None,
    }
}

async fn connect_db2(id: &str) -> qwry_lib::driver::postgres::PgSession {
    postgres::connect(
        &test_profile(id, db2()),
        &env("QWRY_TEST_PASSWORD"),
        None,
        None,
        Box::new(|_, _| {}),
        Box::new(|_| {}),
    )
    .await
    .expect("connect db2")
}

/// SAVEPOINT-wrapped edits inside the user's open transaction: apply works,
/// the outer tx stays open and uncommitted, a verify failure only undoes the
/// batch, and the user's ROLLBACK erases everything — the driver never
/// COMMITs the user's transaction.
#[tokio::test]
#[ignore]
async fn staging_savepoint_inside_user_tx() {
    use qwry_lib::driver::postgres::edit::RowEdit;
    use qwry_lib::driver::TxState;

    let session = connect_db2("test-sp").await;
    let watcher = connect_db2("test-sp-watch").await;

    session
        .execute_simple(
            "CREATE SCHEMA IF NOT EXISTS qwry_test;
             DROP TABLE IF EXISTS qwry_test.qwry_scratch_sp;
             CREATE TABLE qwry_test.qwry_scratch_sp (id int PRIMARY KEY, v text);
             INSERT INTO qwry_test.qwry_scratch_sp VALUES (1, 'one'), (2, 'two')",
        )
        .await
        .expect("setup");

    let sql = "SELECT id, v FROM qwry_test.qwry_scratch_sp ORDER BY id";
    let map = session.editability(sql, 0, None).await.expect("map");
    let oid = map.columns[0].table_oid;

    // open the USER's transaction and do some work in it
    session.execute_simple("BEGIN").await.expect("begin");
    assert_eq!(session.tx_state(), TxState::InTx);
    session
        .execute_simple("INSERT INTO qwry_test.qwry_scratch_sp VALUES (3, 'three')")
        .await
        .expect("user work in tx");

    // an edit commit inside the tx: SAVEPOINT-wrapped, applies, never COMMITs
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 1,
        value: Some("uno".into()),
        use_default: false,
        pk: vec![(0, Some("1".into()))],
        guard: vec![],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply");
    assert!(outcome.committed, "edit must apply inside the open tx");
    assert_eq!(outcome.results[0].new_value.as_deref(), Some("uno"));
    assert_eq!(session.tx_state(), TxState::InTx, "outer tx must stay open");

    // same session sees the edit AND the user's own insert
    let mine = session
        .execute_simple("SELECT v FROM qwry_test.qwry_scratch_sp WHERE id = 1; SELECT count(*) FROM qwry_test.qwry_scratch_sp")
        .await
        .expect("in-tx read");
    assert_eq!(mine.statements[0].rows[0][0].as_deref(), Some("uno"));
    assert_eq!(mine.statements[1].rows[0][0].as_deref(), Some("3"));

    // a second connection must NOT see any of it — nothing was committed
    let theirs = watcher
        .execute_simple("SELECT v FROM qwry_test.qwry_scratch_sp WHERE id = 1; SELECT count(*) FROM qwry_test.qwry_scratch_sp")
        .await
        .expect("outside read");
    assert_eq!(
        theirs.statements[0].rows[0][0].as_deref(),
        Some("one"),
        "edit must not be committed while the user tx is open"
    );
    assert_eq!(theirs.statements[1].rows[0][0].as_deref(), Some("2"));

    // verify failure inside the tx: batch rolls back to the savepoint, the
    // outer tx (and the earlier applied edit) survive un-failed
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("dos".into()), use_default: false, pk: vec![(0, Some("2".into()))], guard: vec![] },
        RowEdit { table_oid: oid, col: 1, value: Some("ghost".into()), use_default: false, pk: vec![(0, Some("99".into()))], guard: vec![] },
    ];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply2");
    assert!(!outcome.committed, "matched≠1 must undo the savepoint batch");
    assert_eq!(session.tx_state(), TxState::InTx, "outer tx must survive the failed batch");
    let mine = session
        .execute_simple("SELECT v FROM qwry_test.qwry_scratch_sp WHERE id IN (1,2) ORDER BY id")
        .await
        .expect("in-tx read 2");
    assert_eq!(mine.statements[0].rows[0][0].as_deref(), Some("uno"), "earlier in-tx edit survives");
    assert_eq!(mine.statements[0].rows[1][0].as_deref(), Some("two"), "failed batch fully undone");

    // the user rolls back — EVERYTHING vanishes (proves no COMMIT was sent)
    session.execute_simple("ROLLBACK").await.expect("rollback");
    assert_eq!(session.tx_state(), TxState::Idle);
    let after = session
        .execute_simple("SELECT v FROM qwry_test.qwry_scratch_sp WHERE id = 1; SELECT count(*) FROM qwry_test.qwry_scratch_sp")
        .await
        .expect("post-rollback read");
    assert_eq!(after.statements[0].rows[0][0].as_deref(), Some("one"), "nothing may persist after user ROLLBACK");
    assert_eq!(after.statements[1].rows[0][0].as_deref(), Some("2"));

    session
        .execute_simple("DROP TABLE qwry_test.qwry_scratch_sp")
        .await
        .expect("cleanup");
}

/// ctid-located edits/deletes carry old-value guards: a stale guard (row
/// changed under us) or a moved row rolls the batch back; a fresh one applies.
#[tokio::test]
#[ignore]
async fn staging_ctid_guard() {
    use qwry_lib::driver::postgres::edit::RowEdit;

    let session = connect_db2("test-ctid").await;
    let mover = connect_db2("test-ctid-mover").await;

    session
        .execute_simple(
            "CREATE SCHEMA IF NOT EXISTS qwry_test;
             DROP TABLE IF EXISTS qwry_test.qwry_scratch_ctid;
             CREATE TABLE qwry_test.qwry_scratch_ctid (a int, b text);
             INSERT INTO qwry_test.qwry_scratch_ctid VALUES (1, 'one'), (2, 'two')",
        )
        .await
        .expect("setup");

    let sql = "SELECT ctid, a, b FROM qwry_test.qwry_scratch_ctid ORDER BY a";
    let map = session.editability(sql, 0, None).await.expect("map");
    assert!(map.columns[1].editable, "no-PK table with ctid in result must be editable");
    assert!(map.columns[1].warn.as_deref().unwrap_or("").contains("ctid"));
    let oid = map.columns[1].table_oid;

    let rows = session.execute_simple(sql).await.expect("read").statements.remove(0).rows;
    let ctid1 = rows[0][0].clone();

    // guard mismatch: pretend the row's old values were different → 0 matched
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 2,
        value: Some("changed".into()),
        use_default: false,
        pk: vec![(0, ctid1.clone())],
        guard: vec![(1, Some("1".into())), (2, Some("STALE-OLD-VALUE".into()))],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply stale guard");
    assert!(!outcome.committed, "stale guard must roll back");
    let check = session
        .execute_simple("SELECT b FROM qwry_test.qwry_scratch_ctid WHERE a = 1")
        .await
        .expect("check");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("one"), "no write on stale guard");

    // correct guard applies
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 2,
        value: Some("uno".into()),
        use_default: false,
        pk: vec![(0, ctid1.clone())],
        guard: vec![(1, Some("1".into())), (2, Some("one".into()))],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply good guard");
    assert!(outcome.committed, "{:?}", outcome.results);

    // row MOVED (another session's UPDATE gives it a new ctid): the old ctid
    // locator matches nothing → rollback, never a write to a different row
    mover
        .execute_simple("UPDATE qwry_test.qwry_scratch_ctid SET b = 'moved' WHERE a = 1")
        .await
        .expect("move row");
    let edits = vec![RowEdit {
        table_oid: oid,
        col: 2,
        value: Some("after-move".into()),
        use_default: false,
        pk: vec![(0, ctid1)],
        guard: vec![(1, Some("1".into())), (2, Some("uno".into()))],
    }];
    let outcome = session.apply_edits(sql, 0, edits, None).await.expect("apply after move");
    assert!(!outcome.committed, "moved row must not be written through a stale ctid");

    // delete path honors guard pairs too: wrong old value → rollback
    let rows = session.execute_simple(sql).await.expect("read2").statements.remove(0).rows;
    let ctid2 = rows.iter().find(|r| r[1].as_deref() == Some("2")).expect("row a=2")[0].clone();
    let outcome = session
        .delete_rows(sql, 0, oid, vec![vec![(0, ctid2.clone()), (2, Some("WRONG".into()))]], None)
        .await
        .expect("guarded delete stale");
    assert!(!outcome.committed, "stale delete guard must roll back");
    let outcome = session
        .delete_rows(sql, 0, oid, vec![vec![(0, ctid2), (2, Some("two".into()))]], None)
        .await
        .expect("guarded delete ok");
    assert!(outcome.committed);
    let check = session
        .execute_simple("SELECT count(*) FROM qwry_test.qwry_scratch_ctid")
        .await
        .expect("check2");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("1"));

    session
        .execute_simple("DROP TABLE qwry_test.qwry_scratch_ctid")
        .await
        .expect("cleanup");
}

/// GENERATED ALWAYS (stored) and identity-ALWAYS columns are read-only with
/// precise reasons — on both the derived and the snapshot-hinted paths — and
/// matviews get an honest reason instead of a dead-end ctid suggestion.
#[tokio::test]
#[ignore]
async fn staging_generated_identity_readonly() {
    use qwry_lib::driver::postgres::edit::TableIdentityHint;

    let session = connect_db2("test-gen").await;
    session
        .execute_simple(
            "CREATE SCHEMA IF NOT EXISTS qwry_test;
             DROP TABLE IF EXISTS qwry_test.qwry_scratch_gen;
             CREATE TABLE qwry_test.qwry_scratch_gen (
               id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
               a int,
               dbl int GENERATED ALWAYS AS (a * 2) STORED);
             INSERT INTO qwry_test.qwry_scratch_gen (a) VALUES (10), (20)",
        )
        .await
        .expect("setup");

    let sql = "SELECT id, a, dbl FROM qwry_test.qwry_scratch_gen ORDER BY id";
    let map = session.editability(sql, 0, None).await.expect("derived map");
    assert!(!map.columns[0].editable, "identity ALWAYS must be read-only");
    assert!(
        map.columns[0].reason.as_deref().unwrap().contains("identity"),
        "{:?}",
        map.columns[0].reason
    );
    assert!(map.columns[1].editable, "plain column stays editable");
    assert!(!map.columns[2].editable, "generated column must be read-only");
    assert!(
        map.columns[2].reason.as_deref().unwrap().contains("generated"),
        "{:?}",
        map.columns[2].reason
    );

    // snapshot-hinted path (zero catalog trips) must agree
    let oid = map.columns[0].table_oid;
    let identity = vec![TableIdentityHint {
        table_oid: oid,
        schema: "qwry_test".into(),
        name: "qwry_scratch_gen".into(),
        pk_attnums: vec![1],
        relkind: "r".into(),
        generated_attnums: vec![3],
        identity_always_attnums: vec![1],
    }];
    let hinted = session.editability(sql, 0, Some(&identity)).await.expect("hinted map");
    for (h, d) in hinted.columns.iter().zip(map.columns.iter()) {
        assert_eq!(h.editable, d.editable, "hinted/derived editable diverged on col {}", d.col);
    }
    assert!(hinted.columns[0].reason.as_deref().unwrap().contains("identity"));
    assert!(hinted.columns[2].reason.as_deref().unwrap().contains("generated"));

    // matview: honest reason, no ctid dead end, no ctid fake-editability
    session
        .execute_simple(
            "DROP MATERIALIZED VIEW IF EXISTS qwry_test.qwry_scratch_mv;
             CREATE MATERIALIZED VIEW qwry_test.qwry_scratch_mv AS
               SELECT a FROM qwry_test.qwry_scratch_gen",
        )
        .await
        .expect("matview setup");
    let mv_map = session
        .editability("SELECT ctid, a FROM qwry_test.qwry_scratch_mv", 0, None)
        .await
        .expect("mv map");
    assert!(!mv_map.columns[1].editable, "matview column must be read-only even with ctid selected");
    let reason = mv_map.columns[1].reason.clone().unwrap_or_default();
    assert!(reason.contains("materialized view"), "reason should name the matview: {reason}");
    assert!(!reason.to_lowercase().contains("ctid"), "no dead-end ctid suggestion: {reason}");

    session
        .execute_simple(
            "DROP MATERIALIZED VIEW qwry_test.qwry_scratch_mv;
             DROP TABLE qwry_test.qwry_scratch_gen",
        )
        .await
        .expect("cleanup");
}

/// schema/table names containing literal dots: identity is carried as
/// separate fields, generated SQL quotes each part, edits hit the right row
#[tokio::test]
#[ignore]
async fn staging_dotted_names() {
    use qwry_lib::driver::postgres::edit::RowEdit;

    let session = connect_db2("test-dot").await;
    session
        .execute_simple(
            r#"DROP SCHEMA IF EXISTS "qwry.dotted" CASCADE;
               CREATE SCHEMA "qwry.dotted";
               CREATE TABLE "qwry.dotted"."ta.ble" (id int PRIMARY KEY, v text);
               INSERT INTO "qwry.dotted"."ta.ble" VALUES (1, 'one'), (2, 'two')"#,
        )
        .await
        .expect("setup");

    let sql = r#"SELECT id, v FROM "qwry.dotted"."ta.ble" ORDER BY id"#;
    let map = session.editability(sql, 0, None).await.expect("map");
    let oid = map.columns[0].table_oid;
    let r = map.table_refs.get(&oid).expect("table ref");
    assert_eq!(r.schema, "qwry.dotted");
    assert_eq!(r.name, "ta.ble");
    assert!(map.columns[1].editable);

    let preview = session
        .build_edit_statements(
            sql,
            0,
            &[RowEdit {
                table_oid: oid,
                col: 1,
                value: Some("uno".into()),
                use_default: false,
                pk: vec![(0, Some("1".into()))],
                guard: vec![],
            }],
            None,
        )
        .await
        .expect("preview");
    assert!(
        preview[0].starts_with(r#"UPDATE "qwry.dotted"."ta.ble" SET"#),
        "{}",
        preview[0]
    );

    let outcome = session
        .apply_edits(
            sql,
            0,
            vec![RowEdit {
                table_oid: oid,
                col: 1,
                value: Some("uno".into()),
                use_default: false,
                pk: vec![(0, Some("1".into()))],
                guard: vec![],
            }],
            None,
        )
        .await
        .expect("apply");
    assert!(outcome.committed, "{:?}", outcome.results);
    let check = session
        .execute_simple(r#"SELECT v FROM "qwry.dotted"."ta.ble" ORDER BY id"#)
        .await
        .expect("check");
    assert_eq!(check.statements[0].rows[0][0].as_deref(), Some("uno"));
    assert_eq!(check.statements[0].rows[1][0].as_deref(), Some("two"));

    session
        .execute_simple(r#"DROP SCHEMA "qwry.dotted" CASCADE"#)
        .await
        .expect("cleanup");
}

/// out-of-band cancel: pg_cancel_backend over a FRESH connection kills a
/// running query without touching the busy session; terminate_backend is the
/// final tier and kills the whole backend
#[tokio::test]
#[ignore]
async fn staging_oob_cancel() {
    use qwry_lib::driver::QueryEvent;
    use std::sync::Arc;

    let session = Arc::new(connect_db2("test-oob").await);
    assert!(session.backend_pid() > 0, "backend pid must be captured at connect");

    // tier 2 alone (skipping the CancelToken): fresh-connection cancel lands
    let s2 = session.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        s2.cancel_out_of_band().await.expect("oob cancel");
    });
    let start = std::time::Instant::now();
    let mut sink = |_ev: QueryEvent| true;
    let res = session.execute_stream("SELECT pg_sleep(30)", &mut sink).await;
    canceller.await.unwrap();
    assert!(start.elapsed().as_secs() < 6, "oob cancel should kill quickly");
    let msg = format!("{}", res.expect_err("expected cancel error"));
    assert!(msg.contains("cancel") || msg.contains("statement"), "unexpected: {msg}");
    // the session survives a statement cancel
    session.execute_simple("SELECT 1").await.expect("session alive after oob cancel");

    // tier 3: terminate kills the backend outright
    let victim = Arc::new(connect_db2("test-oob-victim").await);
    let v2 = victim.clone();
    let terminator = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        v2.terminate_backend().await.expect("terminate");
    });
    let mut sink = |_ev: QueryEvent| true;
    let res = victim.execute_stream("SELECT pg_sleep(30)", &mut sink).await;
    terminator.await.unwrap();
    assert!(res.is_err(), "terminated query must error");
    assert!(
        victim.execute_simple("SELECT 1").await.is_err(),
        "terminated backend's session must be dead"
    );
}

/// driver-tracked tx state: heads + error outcomes, live against the server
#[tokio::test]
#[ignore]
async fn staging_tx_state_tracking() {
    use qwry_lib::driver::TxState;
    use std::sync::{Arc, Mutex};

    let session = connect_db2("test-tx").await;
    let seen: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = seen.clone();
        session.set_tx_listener(Box::new(move |st| {
            seen.lock().unwrap().push(st.as_str());
        }));
    }

    assert_eq!(session.tx_state(), TxState::Idle);
    // error OUTSIDE a tx: stays idle
    let _ = session.execute_simple("SELEC oops").await;
    assert_eq!(session.tx_state(), TxState::Idle);

    session.execute_simple("BEGIN").await.expect("begin");
    assert_eq!(session.tx_state(), TxState::InTx);
    session.execute_simple("SAVEPOINT s1").await.expect("savepoint");
    assert_eq!(session.tx_state(), TxState::InTx);
    // error INSIDE the tx: failed
    let _ = session.execute_simple("SELEC oops").await;
    assert_eq!(session.tx_state(), TxState::FailedTx);
    // ROLLBACK TO recovers without ending the tx
    session.execute_simple("ROLLBACK TO SAVEPOINT s1").await.expect("rb to sp");
    assert_eq!(session.tx_state(), TxState::InTx);
    session.execute_simple("COMMIT").await.expect("commit");
    assert_eq!(session.tx_state(), TxState::Idle);

    // statement-at-a-time path folds too
    let mut sink = |_ev: qwry_lib::driver::QueryEvent| true;
    session
        .execute_stream("BEGIN; SELECT 1", &mut sink)
        .await
        .expect("stream begin");
    assert_eq!(session.tx_state(), TxState::InTx);
    session
        .execute_stream("ROLLBACK", &mut sink)
        .await
        .expect("stream rollback");
    assert_eq!(session.tx_state(), TxState::Idle);

    let events = seen.lock().unwrap().clone();
    assert_eq!(
        events,
        vec!["in_tx", "failed_tx", "in_tx", "idle", "in_tx", "idle"],
        "listener must fire on every state CHANGE"
    );
}
