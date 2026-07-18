//! App-local SQLite: connection profiles (sans passwords), query history,
//! tab state. Lives in the platform app-data dir. Schema is versioned via
//! `PRAGMA user_version` — see `migrate`.

use std::borrow::Cow;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::driver::{DriverError, Profile, Result};

/// bump when appending a migration in `migrate`
const SCHEMA_VERSION: i64 = 2;
/// per-row stored SQL cap (bytes, cut at a char boundary) — a pasted multi-MB
/// INSERT must not bloat the appdb forever
const HISTORY_SQL_CAP: usize = 20_000;
const HISTORY_TRUNC_MARKER: &str = " …[truncated]";
/// total history rows kept; the oldest beyond this are pruned on insert
const HISTORY_ROW_CAP: i64 = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabRow {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub position: i64,
    #[serde(default)]
    pub saved_id: Option<String>,
    /// owning connection; NULL = legacy tab (visible everywhere, adopted on
    /// first edit under a profile)
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub created_at: String,
    /// owning connection; NULL = legacy bookmark (visible everywhere until
    /// next saved under a connection — adopt-on-touch, mirrors tabs)
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// mirrored in src/ipc/types.ts
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryStatus {
    Ok,
    Error,
    Cancelled,
}

impl HistoryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromSql for HistoryStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "ok" => Ok(Self::Ok),
            "error" => Ok(Self::Error),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(FromSqlError::Other(
                format!("unknown history status {other:?}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    pub id: i64,
    pub profile_id: String,
    pub sql: String,
    pub ms: f64,
    pub rows: i64,
    pub ran_at: String,
    pub status: HistoryStatus,
}

pub struct AppDb(Mutex<Connection>);

impl AppDb {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| DriverError::Internal(format!("appdb dir: {e}")))?;
        let mut conn = Connection::open(dir.join("qwry.sqlite"))
            .map_err(|e| DriverError::Internal(format!("appdb open: {e}")))?;
        conn.execute_batch("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;")
            .map_err(|e| DriverError::Internal(format!("appdb init: {e}")))?;
        migrate(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, data FROM profiles ORDER BY position, rowid")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(internal)?;
        // one corrupt row degrades to "that profile missing", never "all
        // connections gone" — skip and log instead of aborting the list
        let mut out = Vec::new();
        for row in rows {
            let (id, data) = match row {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("appdb: skipping corrupt profile row: {e}");
                    continue;
                }
            };
            match serde_json::from_str::<Profile>(&data) {
                Ok(p) => out.push(p),
                Err(e) => eprintln!("appdb: skipping corrupt profile row {id}: {e}"),
            }
        }
        Ok(out)
    }

    pub fn save_profile(&self, profile: &Profile) -> Result<()> {
        let data = serde_json::to_string(profile)
            .map_err(|e| DriverError::Internal(e.to_string()))?;
        self.0
            .lock()
            .unwrap()
            .execute(
                // new rows append at the end; existing rows keep their position
                "INSERT INTO profiles (id, data, position)
                 VALUES (?1, ?2, COALESCE((SELECT MAX(position) FROM profiles), 0) + 1)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                rusqlite::params![profile.id, data],
            )
            .map_err(internal)?;
        Ok(())
    }

    /// persist the rail order
    pub fn set_profile_order(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(internal)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE profiles SET position = ?1 WHERE id = ?2",
                rusqlite::params![i as i64, id],
            )
            .map_err(internal)?;
        }
        tx.commit().map_err(internal)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(internal)?;
        // its cached schema snapshot dies with it
        conn.execute("DELETE FROM schema_cache WHERE profile_id = ?1", [id])
            .map_err(internal)?;
        Ok(())
    }
}

/// `PRAGMA user_version`-numbered migrations, each applied in its own
/// transaction and stamped on commit. v1 is the pre-versioning schema as a
/// baseline: legacy DBs predate the stamp and already hold some or all of it,
/// so v1 deliberately uses CREATE TABLE IF NOT EXISTS plus column-checked
/// ALTERs — it fills exactly what's missing, re-runs nothing, and real errors
/// propagate (the old `let _ = ALTER` pattern swallowed everything).
fn migrate(conn: &mut Connection) -> Result<()> {
    let mut version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(internal)?;
    if version > SCHEMA_VERSION {
        return Err(DriverError::Internal(format!(
            "appdb schema is v{version} but this build supports up to v{SCHEMA_VERSION} — \
             it was written by a newer qwry; refusing to open"
        )));
    }
    while version < SCHEMA_VERSION {
        let next = version + 1;
        let tx = conn.transaction().map_err(internal)?;
        match next {
            1 => baseline_v1(&tx)?,
            2 => history_status_v2(&tx)?,
            n => return Err(DriverError::Internal(format!("appdb: no migration to v{n}"))),
        }
        tx.pragma_update(None, "user_version", next).map_err(internal)?;
        tx.commit().map_err(internal)?;
        version = next;
    }
    Ok(())
}

fn baseline_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profiles (
             id   TEXT PRIMARY KEY,
             data TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS tabs (
             id       TEXT PRIMARY KEY,
             name     TEXT NOT NULL,
             sql      TEXT NOT NULL,
             position INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS history (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             profile_id TEXT NOT NULL,
             sql        TEXT NOT NULL,
             ms         REAL NOT NULL,
             rows       INTEGER NOT NULL,
             ran_at     TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS history_profile_time
             ON history (profile_id, ran_at DESC);
         CREATE TABLE IF NOT EXISTS saved_queries (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             sql        TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE TABLE IF NOT EXISTS schema_cache (
             profile_id TEXT PRIMARY KEY,
             sig        TEXT NOT NULL,
             data       TEXT NOT NULL,
             saved_at   TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .map_err(internal)?;
    add_column_if_missing(conn, "tabs", "saved_id", "TEXT")?;
    add_column_if_missing(conn, "tabs", "profile_id", "TEXT")?;
    add_column_if_missing(conn, "saved_queries", "profile_id", "TEXT")?;
    add_column_if_missing(conn, "profiles", "position", "INTEGER")?;
    conn.execute("UPDATE profiles SET position = rowid WHERE position IS NULL", [])
        .map_err(internal)?;
    Ok(())
}

fn history_status_v2(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "history", "status", "TEXT NOT NULL DEFAULT 'ok'")
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            rusqlite::params![table, col],
            |r| r.get(0),
        )
        .map_err(internal)?;
    Ok(n > 0)
}

fn add_column_if_missing(conn: &Connection, table: &str, col: &str, decl: &str) -> Result<()> {
    if !has_column(conn, table, col)? {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])
            .map_err(internal)?;
    }
    Ok(())
}

/// collect decoded rows, skipping (and logging) any that fail — one bad row
/// must cost one row, not the whole list
fn collect_ok<T>(rows: impl Iterator<Item = rusqlite::Result<T>>, what: &str) -> Vec<T> {
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(v) => out.push(v),
            Err(e) => eprintln!("appdb: skipping corrupt {what} row: {e}"),
        }
    }
    out
}

fn cap_sql(sql: &str) -> Cow<'_, str> {
    if sql.len() <= HISTORY_SQL_CAP {
        return Cow::Borrowed(sql);
    }
    let mut end = HISTORY_SQL_CAP;
    while end > 0 && !sql.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(format!("{}{HISTORY_TRUNC_MARKER}", &sql[..end]))
}

/// Persisted stale-while-revalidate schema snapshots: the last introspection
/// result per profile, hydrated INSTANTLY on connect (sidebar + completion at
/// t=0) while the real introspect refreshes in the background. `sig` binds the
/// cache to the profile's connection identity — a repointed profile (different
/// host/db) never hydrates the old server's schema.
impl AppDb {
    pub fn schema_cache_get(&self, profile_id: &str, sig: &str) -> Result<Option<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM schema_cache WHERE profile_id = ?1 AND sig = ?2")
            .map_err(internal)?;
        let mut rows = stmt
            .query(rusqlite::params![profile_id, sig])
            .map_err(internal)?;
        match rows.next().map_err(internal)? {
            Some(row) => Ok(Some(row.get(0).map_err(internal)?)),
            None => Ok(None),
        }
    }

    pub fn schema_cache_put(&self, profile_id: &str, sig: &str, data: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO schema_cache (profile_id, sig, data, saved_at)
                 VALUES (?1, ?2, ?3, datetime('now'))
                 ON CONFLICT(profile_id) DO UPDATE SET
                   sig = excluded.sig, data = excluded.data, saved_at = excluded.saved_at",
                rusqlite::params![profile_id, sig, data],
            )
            .map_err(internal)?;
        Ok(())
    }
}

impl AppDb {
    pub fn tabs_list(&self) -> Result<Vec<TabRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, sql, position, saved_id, profile_id FROM tabs ORDER BY position")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TabRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    position: r.get(3)?,
                    saved_id: r.get(4)?,
                    profile_id: r.get(5)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "tab"))
    }

    /// replace-all save — tab counts are tiny, atomicity matters more
    pub fn tabs_save(&self, tabs: &[TabRow]) -> Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(internal)?;
        tx.execute("DELETE FROM tabs", []).map_err(internal)?;
        for t in tabs {
            tx.execute(
                "INSERT INTO tabs (id, name, sql, position, saved_id, profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![t.id, t.name, t.sql, t.position, t.saved_id, t.profile_id],
            )
            .map_err(internal)?;
        }
        tx.commit().map_err(internal)
    }

    pub fn history_add(
        &self,
        profile_id: &str,
        sql: &str,
        ms: f64,
        rows: i64,
        status: HistoryStatus,
    ) -> Result<()> {
        let sql = cap_sql(sql);
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO history (profile_id, sql, ms, rows, status) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![profile_id, sql.as_ref(), ms, rows, status.as_str()],
        )
        .map_err(internal)?;
        // keep the newest HISTORY_ROW_CAP rows; under the cap the subquery is
        // NULL and `<=` matches nothing
        conn.execute(
            "DELETE FROM history
             WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            [HISTORY_ROW_CAP],
        )
        .map_err(internal)?;
        Ok(())
    }

    pub fn history_search(
        &self,
        profile_id: Option<&str>,
        query: &str,
        limit: i64,
    ) -> Result<Vec<HistoryRow>> {
        let conn = self.0.lock().unwrap();
        // profile_id NULL = search across every connection (history panel)
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, sql, ms, rows, ran_at, status FROM history
                 WHERE (?1 IS NULL OR profile_id = ?1) AND sql LIKE ?2 ESCAPE '\\'
                 ORDER BY ran_at DESC, id DESC LIMIT ?3",
            )
            .map_err(internal)?;
        // escape LIKE metacharacters so searching SQL that CONTAINS % or _
        // (i.e. most LIKE queries) matches literally
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let rows = stmt
            .query_map(rusqlite::params![profile_id, pattern, limit], map_history_row)
            .map_err(internal)?;
        Ok(collect_ok(rows, "history"))
    }

    /// most recent queries across all profiles (for the home dashboard)
    pub fn history_recent(&self, limit: i64) -> Result<Vec<HistoryRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, sql, ms, rows, ran_at, status FROM history
                 ORDER BY ran_at DESC, id DESC LIMIT ?1",
            )
            .map_err(internal)?;
        let rows = stmt.query_map([limit], map_history_row).map_err(internal)?;
        Ok(collect_ok(rows, "history"))
    }
}

fn map_history_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        sql: r.get(2)?,
        ms: r.get(3)?,
        rows: r.get(4)?,
        ran_at: r.get(5)?,
        status: r.get(6)?,
    })
}

impl AppDb {
    pub fn saved_list(&self) -> Result<Vec<SavedQuery>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, sql, created_at, profile_id FROM saved_queries ORDER BY name")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SavedQuery {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    created_at: r.get(3)?,
                    profile_id: r.get(4)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "saved query"))
    }

    pub fn saved_upsert(&self, q: &SavedQuery) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO saved_queries (id, name, sql, profile_id) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, sql = excluded.sql,
                                               profile_id = excluded.profile_id",
                rusqlite::params![q.id, q.name, q.sql, q.profile_id],
            )
            .map_err(internal)?;
        Ok(())
    }

    pub fn saved_delete(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute("DELETE FROM saved_queries WHERE id = ?1", [id])
            .map_err(internal)?;
        Ok(())
    }

    /// days = None → wipe all history for the profile
    pub fn history_clear(&self, profile_id: &str, older_than_days: Option<i64>) -> Result<()> {
        let conn = self.0.lock().unwrap();
        match older_than_days {
            None => conn
                .execute("DELETE FROM history WHERE profile_id = ?1", [profile_id])
                .map(|_| ())
                .map_err(internal),
            Some(d) => conn
                .execute(
                    "DELETE FROM history WHERE profile_id = ?1
                     AND ran_at < datetime('now', ?2)",
                    rusqlite::params![profile_id, format!("-{d} days")],
                )
                .map(|_| ())
                .map_err(internal),
        }
    }
}

fn internal(e: rusqlite::Error) -> DriverError {
    DriverError::Internal(format!("appdb: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qwry-appdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(id: &str) -> Profile {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","name":"t","host":"h","port":5432,"dbname":"d","user":"u"}}"#
        ))
        .unwrap()
    }

    fn user_version(db: &AppDb) -> i64 {
        db.0.lock()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn fresh_db_migrates_to_latest() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        assert_eq!(user_version(&db), SCHEMA_VERSION);

        db.save_profile(&profile("a")).unwrap();
        assert_eq!(db.list_profiles().unwrap().len(), 1);

        db.history_add("a", "select 1", 1.5, 1, HistoryStatus::Cancelled)
            .unwrap();
        let h = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].status, HistoryStatus::Cancelled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopen_is_idempotent() {
        let dir = tmp_dir();
        {
            let db = AppDb::open(&dir).unwrap();
            db.save_profile(&profile("a")).unwrap();
            db.history_add("a", "select 1", 1.0, 1, HistoryStatus::Ok).unwrap();
        }
        let db = AppDb::open(&dir).unwrap();
        assert_eq!(user_version(&db), SCHEMA_VERSION);
        assert_eq!(db.list_profiles().unwrap().len(), 1);
        assert_eq!(db.history_recent(10).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_unversioned_db_stamped_and_data_intact() {
        let dir = tmp_dir();
        {
            // pre-versioning schema: no saved_id/profile_id/position/status
            let conn = Connection::open(dir.join("qwry.sqlite")).unwrap();
            conn.execute_batch(
                "CREATE TABLE profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                 CREATE TABLE tabs (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL,
                     sql TEXT NOT NULL, position INTEGER NOT NULL
                 );
                 CREATE TABLE history (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     profile_id TEXT NOT NULL, sql TEXT NOT NULL,
                     ms REAL NOT NULL, rows INTEGER NOT NULL,
                     ran_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 CREATE TABLE saved_queries (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
                     created_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO profiles (id, data) VALUES ('p1', ?1)",
                [serde_json::to_string(&profile("p1")).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO history (profile_id, sql, ms, rows) VALUES ('p1', 'select 1', 2.0, 3)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tabs (id, name, sql, position) VALUES ('t1', 'n', 's', 0)",
                [],
            )
            .unwrap();
        }

        let db = AppDb::open(&dir).unwrap();
        assert_eq!(user_version(&db), SCHEMA_VERSION);

        let profiles = db.list_profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "p1");
        let pos: i64 = db
            .0
            .lock()
            .unwrap()
            .query_row("SELECT position FROM profiles WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pos, 1);

        let tabs = db.tabs_list().unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].saved_id, None);
        assert_eq!(tabs[0].profile_id, None);

        let h = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].rows, 3);
        assert_eq!(h[0].status, HistoryStatus::Ok);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn already_altered_unversioned_db_stamped() {
        // the shape a real pre-versioning appdb is in today: every legacy
        // `let _ = ALTER` column already present, user_version still 0
        let dir = tmp_dir();
        {
            let conn = Connection::open(dir.join("qwry.sqlite")).unwrap();
            conn.execute_batch(
                "CREATE TABLE profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER);
                 CREATE TABLE tabs (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL,
                     sql TEXT NOT NULL, position INTEGER NOT NULL,
                     saved_id TEXT, profile_id TEXT
                 );
                 CREATE TABLE history (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     profile_id TEXT NOT NULL, sql TEXT NOT NULL,
                     ms REAL NOT NULL, rows INTEGER NOT NULL,
                     ran_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 CREATE INDEX history_profile_time ON history (profile_id, ran_at DESC);
                 CREATE TABLE saved_queries (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
                     created_at TEXT NOT NULL DEFAULT (datetime('now')), profile_id TEXT
                 );
                 CREATE TABLE schema_cache (
                     profile_id TEXT PRIMARY KEY, sig TEXT NOT NULL, data TEXT NOT NULL,
                     saved_at TEXT NOT NULL DEFAULT (datetime('now'))
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO profiles (id, data, position) VALUES ('p1', ?1, 1)",
                [serde_json::to_string(&profile("p1")).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO history (profile_id, sql, ms, rows) VALUES ('p1', 'select 1', 2.0, 3)",
                [],
            )
            .unwrap();
        }

        let db = AppDb::open(&dir).unwrap();
        assert_eq!(user_version(&db), SCHEMA_VERSION);
        assert_eq!(db.list_profiles().unwrap().len(), 1);
        let h = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].status, HistoryStatus::Ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_schema_refused() {
        let dir = tmp_dir();
        {
            let conn = Connection::open(dir.join("qwry.sqlite")).unwrap();
            conn.pragma_update(None, "user_version", 99).unwrap();
        }
        assert!(AppDb::open(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_profile_row_skipped() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.save_profile(&profile("good1")).unwrap();
        db.save_profile(&profile("good2")).unwrap();
        db.0.lock()
            .unwrap()
            .execute(
                "INSERT INTO profiles (id, data, position) VALUES ('bad', '{not json', 99)",
                [],
            )
            .unwrap();
        let profiles = db.list_profiles().unwrap();
        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().all(|p| p.id.starts_with("good")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_tab_and_history_rows_skipped() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.tabs_save(&[TabRow {
            id: "t1".into(),
            name: "n".into(),
            sql: "s".into(),
            position: 0,
            saved_id: None,
            profile_id: None,
        }])
        .unwrap();
        db.history_add("p", "select 1", 1.0, 1, HistoryStatus::Ok).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "INSERT INTO tabs (id, name, sql, position) VALUES ('t2', 'n', 's', 'not-an-int')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO history (profile_id, sql, ms, rows, status)
                 VALUES ('p', 'select 2', 1.0, 1, 'weird')",
                [],
            )
            .unwrap();
        }
        assert_eq!(db.tabs_list().unwrap().len(), 1);
        let h = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].sql, "select 1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_sql_capped_with_marker() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        let long = "x".repeat(HISTORY_SQL_CAP + 5_000);
        db.history_add("p", &long, 1.0, 0, HistoryStatus::Ok).unwrap();
        let h = db.history_recent(1).unwrap();
        assert!(h[0].sql.ends_with(HISTORY_TRUNC_MARKER));
        assert_eq!(h[0].sql.len(), HISTORY_SQL_CAP + HISTORY_TRUNC_MARKER.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_pruned_to_row_cap() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        {
            let mut conn = db.0.lock().unwrap();
            let tx = conn.transaction().unwrap();
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO history (profile_id, sql, ms, rows, status)
                         VALUES ('p', 's', 0, 0, 'ok')",
                    )
                    .unwrap();
                for _ in 0..(HISTORY_ROW_CAP + 100) {
                    stmt.execute([]).unwrap();
                }
            }
            tx.commit().unwrap();
        }
        db.history_add("p", "newest", 1.0, 0, HistoryStatus::Ok).unwrap();
        let (count, min_id): (i64, i64) = db
            .0
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*), MIN(id) FROM history", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(count, HISTORY_ROW_CAP);
        assert_eq!(min_id, 102);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
