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
