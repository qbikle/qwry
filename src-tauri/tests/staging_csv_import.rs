//! Live CSV-import tests against a disposable PostgreSQL database you
//! control (QWRY_TEST_DB2, qwry_test schema), never production. Ignored by
//! default; run with:
//!   cargo test --test staging_csv_import -- --ignored --test-threads=1
//! using QWRY_TEST_HOST / QWRY_TEST_USER / QWRY_TEST_PASSWORD
//! (+ QWRY_TEST_DB2 for the fixture db).

use std::io::Write;

use qwry_lib::driver::{postgres, Profile};
use qwry_lib::import::{run_import, ImportColumnSpec, ImportOutcome, ImportSpec};

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("missing env {k}"))
}

fn db2() -> String {
    std::env::var("QWRY_TEST_DB2").expect("set QWRY_TEST_DB2 to the fixture database")
}

fn test_profile(id: &str) -> Profile {
    Profile {
        id: id.into(),
        name: "staging".into(),
        host: env("QWRY_TEST_HOST"),
        port: 5432,
        dbname: db2(),
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

async fn connect(id: &str) -> postgres::PgSession {
    postgres::connect(
        &test_profile(id),
        &env("QWRY_TEST_PASSWORD"),
        None,
        None,
        Box::new(|_, _| {}),
        Box::new(|_| {}),
    )
    .await
    .expect("connect db2")
}

fn write_csv(name: &str, content: &str) -> String {
    let path = std::env::temp_dir().join(format!("qwry-import-test-{name}.csv"));
    let mut f = std::fs::File::create(&path).expect("create csv");
    f.write_all(content.as_bytes()).expect("write csv");
    path.to_string_lossy().into_owned()
}

/// int/text/bool/timestamp/numeric incl. NOT NULL + DEFAULT (tag is
/// deliberately NEVER mapped; the import must let its DEFAULT apply)
async fn fresh_fixture(session: &postgres::PgSession, table: &str) {
    session
        .execute_simple(&format!(
            "CREATE SCHEMA IF NOT EXISTS qwry_test;
             DROP TABLE IF EXISTS qwry_test.{table};
             CREATE TABLE qwry_test.{table} (
                 id int PRIMARY KEY,
                 name text NOT NULL,
                 ok boolean,
                 created_at timestamp,
                 amount numeric(10,2),
                 tag text NOT NULL DEFAULT 'default-tag'
             )"
        ))
        .await
        .expect("fixture setup");
}

async fn drop_fixture(session: &postgres::PgSession, table: &str) {
    session
        .execute_simple(&format!("DROP TABLE IF EXISTS qwry_test.{table}"))
        .await
        .expect("fixture drop");
}

async fn count(session: &postgres::PgSession, table: &str) -> i64 {
    let out = session
        .execute_simple(&format!("SELECT count(*) FROM qwry_test.{table}"))
        .await
        .expect("count");
    out.statements[0].rows[0][0]
        .as_deref()
        .unwrap()
        .parse()
        .unwrap()
}

fn spec(path: &str, table: &str, mode: &str) -> ImportSpec {
    ImportSpec {
        path: path.into(),
        delimiter: ",".into(),
        has_header: true,
        schema: "qwry_test".into(),
        table: table.into(),
        columns: vec![
            ImportColumnSpec { src: 0, target: "id".into() },
            ImportColumnSpec { src: 1, target: "name".into() },
            ImportColumnSpec { src: 2, target: "ok".into() },
            ImportColumnSpec { src: 3, target: "created_at".into() },
            ImportColumnSpec { src: 4, target: "amount".into() },
        ],
        null_mode: "empty".into(),
        null_token: None,
        mode: mode.into(),
        expected_stat: None,
    }
}

/// happy path: validate writes NOTHING, commit lands values exactly:
/// empty→NULL rule applied, unmapped DEFAULT column defaulted, quotes and
/// embedded delimiters survive round-trip
#[tokio::test]
#[ignore]
async fn staging_csv_import_happy_path() {
    let session = connect("imp-happy").await;
    let table = "qwry_import_happy";
    fresh_fixture(&session, table).await;
    let path = write_csv(
        "happy",
        "id,name,ok,created_at,amount\n\
         1,alpha,true,2026-01-02 03:04:05,10.50\n\
         2,\"be,ta\",false,,-4.25\n\
         3,gam'ma,,2026-12-31 23:59:59,0.00\n",
    );

    // validate first: clean report, and the always-ROLLBACK contract holds
    let mut ticks: Vec<(u64, u64)> = Vec::new();
    let report = run_import(&session, &spec(&path, table, "validate"), &mut |p, t| {
        ticks.push((p, t))
    })
    .await
    .expect("validate");
    assert_eq!(report.total_rows, 3);
    assert_eq!(report.ok_rows, 3);
    assert!(report.errors.is_empty(), "unexpected: {:?}", report.errors);
    assert!(!report.committed);
    assert!(!report.more_errors);
    assert_eq!(count(&session, table).await, 0, "validate must roll back");
    assert_eq!(ticks.last(), Some(&(3, 3)));
    assert_eq!(ticks.first(), Some(&(0, 3)));

    // commit: all three land, exactly
    let report = run_import(&session, &spec(&path, table, "commit"), &mut |_, _| {})
        .await
        .expect("commit");
    assert!(report.committed, "commit failed: {:?}", report.errors);
    assert_eq!(report.ok_rows, 3);

    let out = session
        .execute_simple(&format!(
            "SELECT id, name, ok, created_at, amount, tag FROM qwry_test.{table} ORDER BY id"
        ))
        .await
        .expect("verify select");
    let rows = &out.statements[0].rows;
    assert_eq!(rows.len(), 3);
    let cell = |r: usize, c: usize| rows[r][c].as_deref();
    assert_eq!(cell(0, 0), Some("1"));
    assert_eq!(cell(0, 1), Some("alpha"));
    assert_eq!(cell(0, 2), Some("t"));
    assert_eq!(cell(0, 3), Some("2026-01-02 03:04:05"));
    assert_eq!(cell(0, 4), Some("10.50"));
    assert_eq!(cell(0, 5), Some("default-tag"), "unmapped column must DEFAULT");
    assert_eq!(cell(1, 1), Some("be,ta"), "quoted embedded delimiter");
    assert_eq!(cell(1, 3), None, "empty field → NULL under the empty rule");
    assert_eq!(cell(1, 4), Some("-4.25"));
    assert_eq!(cell(2, 1), Some("gam'ma"), "single quote survives escaping");
    assert_eq!(cell(2, 2), None, "empty bool → NULL");
    assert_eq!(cell(2, 5), Some("default-tag"));

    drop_fixture(&session, table).await;
}

/// type mismatches at known rows: validate names exactly those rows (with
/// the server's message), everything else passes, and NOTHING is written
#[tokio::test]
#[ignore]
async fn staging_csv_import_validate_bad_rows() {
    let session = connect("imp-badrows").await;
    let table = "qwry_import_badrows";
    fresh_fixture(&session, table).await;
    let path = write_csv(
        "badrows",
        "id,name,ok,created_at,amount\n\
         1,one,true,2026-01-01 00:00:00,1.00\n\
         xx,two,true,2026-01-01 00:00:00,2.00\n\
         3,three,false,,3.00\n\
         4,four,,2026-01-04 00:00:00,4.00\n\
         5,five,true,2026-01-05 00:00:00,not-a-number\n",
    );

    let report = run_import(&session, &spec(&path, table, "validate"), &mut |_, _| {})
        .await
        .expect("validate");
    assert_eq!(report.total_rows, 5);
    assert_eq!(report.ok_rows, 3);
    assert!(!report.more_errors);
    let bad_rows: Vec<u64> = report.errors.iter().map(|e| e.row).collect();
    assert_eq!(bad_rows, vec![2, 5], "exact bad-row attribution: {:?}", report.errors);
    assert!(
        report.errors[0].message.contains("integer"),
        "row 2 should be the int cast failure: {}",
        report.errors[0].message
    );
    assert!(
        report.errors[1].message.contains("numeric"),
        "row 5 should be the numeric cast failure: {}",
        report.errors[1].message
    );
    // file lines: header is line 1, so data row N sits on line N+1
    assert_eq!(report.errors[0].line, 3);
    assert_eq!(report.errors[1].line, 6);
    assert_eq!(count(&session, table).await, 0, "validate must write nothing");

    drop_fixture(&session, table).await;
}

/// a short row is a per-row ERROR, never silently padded with NULLs
#[tokio::test]
#[ignore]
async fn staging_csv_import_short_row() {
    let session = connect("imp-short").await;
    let table = "qwry_import_short";
    fresh_fixture(&session, table).await;
    let path = write_csv(
        "short",
        "id,name,ok,created_at,amount\n\
         1,one,true,2026-01-01 00:00:00,1.00\n\
         2,two-short\n\
         3,three,false,2026-01-03 00:00:00,3.00\n",
    );

    let report = run_import(&session, &spec(&path, table, "validate"), &mut |_, _| {})
        .await
        .expect("validate");
    assert_eq!(report.total_rows, 3);
    assert_eq!(report.ok_rows, 2);
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].row, 2);
    assert!(
        report.errors[0].message.contains("2 fields") &&
        report.errors[0].message.contains("expected 5"),
        "short row must be reported, not padded: {}",
        report.errors[0].message
    );
    assert_eq!(count(&session, table).await, 0);

    drop_fixture(&session, table).await;
}

/// commit is all-or-nothing across batches: 1200 rows with ONE bad row in
/// batch 3 → zero rows persisted, the report names the batch; the same file
/// without the bad row commits all 1200 (multi-batch happy path)
#[tokio::test]
#[ignore]
async fn staging_csv_import_all_or_nothing() {
    let session = connect("imp-atomic").await;
    let table = "qwry_import_atomic";
    fresh_fixture(&session, table).await;

    let mut good = String::from("id,name,ok,created_at,amount\n");
    let mut bad = good.clone();
    for i in 1..=1200 {
        let line = format!("{i},row {i},true,2026-01-01 00:00:00,{i}.25\n");
        good.push_str(&line);
        if i == 1100 {
            bad.push_str(&format!("{i},row {i},true,2026-01-01 00:00:00,oops\n"));
        } else {
            bad.push_str(&line);
        }
    }
    let bad_path = write_csv("atomic-bad", &bad);
    let good_path = write_csv("atomic-good", &good);

    let report = run_import(&session, &spec(&bad_path, table, "commit"), &mut |_, _| {})
        .await
        .expect("commit run");
    assert!(!report.committed);
    assert_eq!(report.ok_rows, 0, "all-or-nothing: nothing may persist");
    assert_eq!(report.errors.len(), 1);
    assert!(
        report.errors[0].message.contains("batch 3"),
        "failure must name the batch: {}",
        report.errors[0].message
    );
    assert_eq!(
        report.errors[0].row, 1100,
        "server position should attribute the exact row: {:?}",
        report.errors[0]
    );
    assert_eq!(count(&session, table).await, 0, "zero rows after failed commit");

    // same file minus the bad row commits across 3 batches
    let mut ticks: Vec<(u64, u64)> = Vec::new();
    let report = run_import(&session, &spec(&good_path, table, "commit"), &mut |p, t| {
        ticks.push((p, t))
    })
    .await
    .expect("good commit");
    assert!(report.committed, "good commit failed: {:?}", report.errors);
    assert_eq!(report.outcome, ImportOutcome::Committed);
    assert_eq!(report.ok_rows, 1200);
    assert_eq!(count(&session, table).await, 1200);
    assert_eq!(ticks.last(), Some(&(1200, 1200)));
    assert!(ticks.windows(2).all(|w| w[0].0 <= w[1].0), "monotonic progress");

    drop_fixture(&session, table).await;
}

/// validate→commit TOCTOU gate: the validate report carries the file's
/// mtime+size identity; a commit fed that stat refuses when the file changed
/// in between (nothing written), and a re-validate → fresh-stat commit lands
/// the CURRENT file's rows exactly
#[tokio::test]
#[ignore]
async fn staging_csv_import_file_changed_gate() {
    let session = connect("imp-toctou").await;
    let table = "qwry_import_toctou";
    fresh_fixture(&session, table).await;
    let path = write_csv(
        "toctou",
        "id,name,ok,created_at,amount\n\
         1,one,true,2026-01-01 00:00:00,1.00\n\
         2,two,false,,2.00\n",
    );

    let report = run_import(&session, &spec(&path, table, "validate"), &mut |_, _| {})
        .await
        .expect("validate");
    assert!(report.errors.is_empty(), "unexpected: {:?}", report.errors);
    assert_eq!(report.outcome, ImportOutcome::RolledBack);
    let stat = report.file_stat.expect("validate report must carry the file stat");

    // the file changes AFTER validation (different size; mtime granularity
    // must not be the only tripwire)
    let path = write_csv(
        "toctou",
        "id,name,ok,created_at,amount\n\
         1,one,true,2026-01-01 00:00:00,1.00\n\
         2,two,false,,2.00\n\
         3,three,true,2026-01-03 00:00:00,3.00\n",
    );
    let mut stale = spec(&path, table, "commit");
    stale.expected_stat = Some(stat);
    let err = run_import(&session, &stale, &mut |_, _| {})
        .await
        .expect_err("commit against a changed file must refuse");
    assert!(
        format!("{err}").contains("file changed since validation"),
        "refusal must be actionable: {err}"
    );
    assert_eq!(count(&session, table).await, 0, "refused commit must write nothing");
    // the session is idle again; a fresh run must be possible
    let report = run_import(&session, &spec(&path, table, "validate"), &mut |_, _| {})
        .await
        .expect("re-validate");
    assert_eq!(report.total_rows, 3);
    let fresh = report.file_stat.expect("fresh stat");
    let mut commit = spec(&path, table, "commit");
    commit.expected_stat = Some(fresh);
    let report = run_import(&session, &commit, &mut |_, _| {})
        .await
        .expect("commit with fresh stat");
    assert!(report.committed, "fresh-stat commit failed: {:?}", report.errors);
    assert_eq!(report.outcome, ImportOutcome::Committed);
    assert_eq!(report.ok_rows, 3);
    assert!(report.file_stat.is_none(), "commit reports carry no stat");
    assert_eq!(count(&session, table).await, 3);

    drop_fixture(&session, table).await;
}
