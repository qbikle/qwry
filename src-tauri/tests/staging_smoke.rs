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
        is_prod: false,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"))
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
        is_prod: false,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"))
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
        is_prod: false,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"))
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
    let map = session.editability(sql, 0).await.expect("editability");
    assert!(map.columns[0].editable, "id should be editable");
    assert!(map.columns[1].editable, "name should be editable");
    assert!(map.columns[2].editable, "val should be editable");
    assert!(!map.columns[3].editable, "computed col must be read-only");
    assert!(map.columns[3].reason.as_deref().unwrap().contains("computed"));

    // no PK in selection → read-only with actionable reason
    let map2 = session
        .editability("SELECT name FROM qwry_edit_test", 0)
        .await
        .expect("editability2");
    assert!(!map2.columns[0].editable);
    assert!(map2.columns[0].reason.as_deref().unwrap().contains("primary key"));

    // preview generates sane SQL
    let oid = map.columns[0].table_oid;
    let edits = vec![
        RowEdit { table_oid: oid, col: 1, value: Some("edited".into()), pk: vec![(0, Some("2".into()))] },
        RowEdit { table_oid: oid, col: 2, value: None, pk: vec![(0, Some("1".into()))] },
    ];
    let preview = session
        .build_edit_statements(sql, 0, &edits)
        .await
        .expect("preview");
    assert_eq!(preview.len(), 2);
    assert!(preview[0].contains(r#"SET "name" = 'edited'::text WHERE "id" = '2'::int4"#), "{}", preview[0]);
    assert!(preview[1].contains(r#"SET "val" = NULL"#), "{}", preview[1]);

    // apply in one tx, RETURNING refreshes
    let outcome = session.apply_edits(sql, 0, edits).await.expect("apply");
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
    let jmap = session.editability(join_sql, 0).await.expect("join map");
    assert!(jmap.columns[1].editable, "joined base col should be editable");

    session
        .execute_simple("DROP TABLE qwry_edit_test")
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
        is_prod: false,
    };
    let session = postgres::connect(&profile, &env("QWRY_TEST_PASSWORD"))
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
