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
const SCHEMA_VERSION: i64 = 5;
/// per-row stored SQL cap (bytes, cut at a char boundary) — a pasted multi-MB
/// INSERT must not bloat the appdb forever
const HISTORY_SQL_CAP: usize = 20_000;
const HISTORY_TRUNC_MARKER: &str = " …[truncated]";
/// total history rows kept; the oldest beyond this are pruned on insert
const HISTORY_ROW_CAP: i64 = 20_000;
/// history_search scans only the newest N rows (per profile filter). A
/// substring LIKE can never use the btree index, so the palette's
/// per-keystroke search bounds its scan here instead of walking all 20k rows
/// (× up to 20KB of SQL each). Tradeoff, documented: matches older than the
/// newest 5k searched rows are not returned — acceptable for a
/// recency-ranked palette; FTS would lift the bound if that ever hurts.
const HISTORY_SEARCH_WINDOW: i64 = 5_000;
/// distinct server builds whose pg_catalog function lists we keep cached
const PG_CATALOG_CACHE_CAP: i64 = 8;
/// undo-log rows kept per profile (newest); expired rows pruned on every write
const UNDO_KEEP_PER_PROFILE: i64 = 20;
/// buffer snapshots kept per tab (newest)
const SNAPSHOT_KEEP_PER_TAB: i64 = 50;
/// per-snapshot stored SQL cap (bytes, cut at a char boundary)
const SNAPSHOT_SQL_CAP: usize = 200_000;

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

    /// second element = skipped-row count, surfaced to the UI as a warning
    pub fn list_profiles(&self) -> Result<(Vec<Profile>, usize)> {
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
        let mut skipped = 0usize;
        for row in rows {
            let (id, data) = match row {
                Ok(v) => v,
                Err(e) => {
                    skipped += 1;
                    eprintln!("appdb: skipping corrupt profile row: {e}");
                    continue;
                }
            };
            match serde_json::from_str::<Profile>(&data) {
                Ok(p) => out.push(p),
                Err(e) => {
                    skipped += 1;
                    eprintln!("appdb: skipping corrupt profile row {id}: {e}");
                }
            }
        }
        Ok((out, skipped))
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
            3 => pg_catalog_cache_v3(&tx)?,
            4 => undo_log_v4(&tx)?,
            5 => buffer_snapshots_v5(&tx)?,
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

/// pg_catalog functions per server build (see `pg_catalog_funcs_get`)
fn pg_catalog_cache_v3(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pg_catalog_cache (
             server_version TEXT PRIMARY KEY,
             funcs          TEXT NOT NULL,
             saved_at       TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .map_err(internal)
}

/// inverse-SQL undo after commit: one row per committed edit/delete batch.
/// `revert_sql` holds the structured revert plan (JSON — regenerated into SQL
/// by the driver's own generator at undo time, never parsed). `session_key`
/// stamps the committing session; undo is refused across reconnects.
fn undo_log_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS undo_log (
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             profile_id  TEXT NOT NULL,
             session_key TEXT NOT NULL,
             created_at  TEXT NOT NULL DEFAULT (datetime('now')),
             description TEXT NOT NULL,
             revert_sql  TEXT NOT NULL,
             expires_at  TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS undo_log_profile ON undo_log (profile_id, id DESC);",
    )
    .map_err(internal)
}

/// buffer time-machine: executed versions of each tab's editor buffer
fn buffer_snapshots_v5(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS buffer_snapshots (
             id       INTEGER PRIMARY KEY AUTOINCREMENT,
             tab_id   TEXT NOT NULL,
             taken_at TEXT NOT NULL DEFAULT (datetime('now')),
             sql      TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS buffer_snapshots_tab ON buffer_snapshots (tab_id, id DESC);",
    )
    .map_err(internal)
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
/// must cost one row, not the whole list. Returns the skip count so callers
/// can surface it to the UI. NEVER use for tabs: a skipped tab row feeding
/// the replace-all tabs_save would permanently delete that tab's SQL.
fn collect_ok<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
    what: &str,
) -> (Vec<T>, usize) {
    let mut out = Vec::new();
    let mut skipped = 0usize;
    for row in rows {
        match row {
            Ok(v) => out.push(v),
            Err(e) => {
                skipped += 1;
                eprintln!("appdb: skipping corrupt {what} row: {e}");
            }
        }
    }
    (out, skipped)
}

fn cap_text(sql: &str, cap: usize) -> Cow<'_, str> {
    if sql.len() <= cap {
        return Cow::Borrowed(sql);
    }
    let mut end = cap;
    while end > 0 && !sql.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(format!("{}{HISTORY_TRUNC_MARKER}", &sql[..end]))
}

fn cap_sql(sql: &str) -> Cow<'_, str> {
    cap_text(sql, HISTORY_SQL_CAP)
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

/// pg_catalog function-list cache, keyed by the full server_version string:
/// pg_catalog contents only change with the server build, so introspection
/// stops re-pulling ~3k rows on every connect/⌘R/DDL refresh. User-schema
/// functions are NOT cached — they stay live on every introspect.
impl AppDb {
    pub fn pg_catalog_funcs_get(&self, server_version: &str) -> Result<Option<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT funcs FROM pg_catalog_cache WHERE server_version = ?1")
            .map_err(internal)?;
        let mut rows = stmt.query([server_version]).map_err(internal)?;
        match rows.next().map_err(internal)? {
            Some(row) => Ok(Some(row.get(0).map_err(internal)?)),
            None => Ok(None),
        }
    }

    pub fn pg_catalog_funcs_put(&self, server_version: &str, funcs: &str) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO pg_catalog_cache (server_version, funcs, saved_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(server_version) DO UPDATE SET
               funcs = excluded.funcs, saved_at = excluded.saved_at",
            rusqlite::params![server_version, funcs],
        )
        .map_err(internal)?;
        // a lifetime of distinct servers must not grow the appdb unbounded
        conn.execute(
            "DELETE FROM pg_catalog_cache WHERE server_version NOT IN (
                 SELECT server_version FROM pg_catalog_cache
                 ORDER BY saved_at DESC, rowid DESC LIMIT ?1
             )",
            [PG_CATALOG_CACHE_CAP],
        )
        .map_err(internal)?;
        Ok(())
    }
}

impl AppDb {
    /// Row decode errors PROPAGATE here (unlike the other lists): tabs feed a
    /// replace-all `tabs_save`, so a silently skipped row would come back as
    /// the permanent deletion of that tab's SQL. The frontend's loaded-gate +
    /// retry loop is the designed protection and it needs the error.
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
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(internal)?);
        }
        Ok(out)
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
    ) -> Result<(Vec<HistoryRow>, usize)> {
        let conn = self.0.lock().unwrap();
        // profile_id NULL = search across every connection (history panel).
        // The inner window bounds the LIKE scan to the newest
        // HISTORY_SEARCH_WINDOW rows (id DESC ≡ insertion order, walked via
        // the rowid PK — the profile filter is applied inside so a busy
        // sibling profile can't starve the window). See the const's doc for
        // the recall tradeoff. Newest-first semantics unchanged.
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, sql, ms, rows, ran_at, status FROM (
                     SELECT id, profile_id, sql, ms, rows, ran_at, status FROM history
                     WHERE (?1 IS NULL OR profile_id = ?1)
                     ORDER BY id DESC LIMIT ?4
                 ) WHERE sql LIKE ?2 ESCAPE '\\'
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
            .query_map(
                rusqlite::params![profile_id, pattern, limit, HISTORY_SEARCH_WINDOW],
                map_history_row,
            )
            .map_err(internal)?;
        Ok(collect_ok(rows, "history"))
    }

    /// most recent queries across all profiles (for the home dashboard)
    pub fn history_recent(&self, limit: i64) -> Result<(Vec<HistoryRow>, usize)> {
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
    pub fn saved_list(&self) -> Result<(Vec<SavedQuery>, usize)> {
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

/// mirrored in src/ipc/types.ts
#[derive(Debug, Clone, Serialize)]
pub struct UndoLogRow {
    pub id: i64,
    pub profile_id: String,
    pub session_key: String,
    pub created_at: String,
    pub description: String,
    /// structured revert plan (JSON) — see driver::postgres::edit::UndoPlan
    pub revert_sql: String,
    pub expires_at: String,
}

/// Inverse-SQL undo log: one row per committed edit/delete batch, aggressively
/// pruned (15-minute TTL + newest UNDO_KEEP_PER_PROFILE per profile). Only the
/// LATEST row per profile is ever offered — a newer commit supersedes.
impl AppDb {
    pub fn undo_log_add(
        &self,
        profile_id: &str,
        session_key: &str,
        description: &str,
        revert_sql: &str,
    ) -> Result<i64> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO undo_log (profile_id, session_key, description, revert_sql, expires_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now', '+15 minutes'))",
            rusqlite::params![profile_id, session_key, description, revert_sql],
        )
        .map_err(internal)?;
        let id = conn.last_insert_rowid();
        conn.execute("DELETE FROM undo_log WHERE expires_at <= datetime('now')", [])
            .map_err(internal)?;
        conn.execute(
            "DELETE FROM undo_log WHERE profile_id = ?1 AND id NOT IN (
                 SELECT id FROM undo_log WHERE profile_id = ?1 ORDER BY id DESC LIMIT ?2
             )",
            rusqlite::params![profile_id, UNDO_KEEP_PER_PROFILE],
        )
        .map_err(internal)?;
        Ok(id)
    }

    /// newest unexpired row for a profile — the only offer ever surfaced
    pub fn undo_log_latest(&self, profile_id: &str) -> Result<Option<UndoLogRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, session_key, created_at, description, revert_sql, expires_at
                 FROM undo_log
                 WHERE profile_id = ?1 AND expires_at > datetime('now')
                 ORDER BY id DESC LIMIT 1",
            )
            .map_err(internal)?;
        let mut rows = stmt.query([profile_id]).map_err(internal)?;
        match rows.next().map_err(internal)? {
            Some(r) => Ok(Some(map_undo_row(r).map_err(internal)?)),
            None => Ok(None),
        }
    }

    /// atomically consume one undo row (select + delete in a transaction) —
    /// an undo is single-shot whether it succeeds or rolls back; expired rows
    /// consume to None
    pub fn undo_log_take(&self, id: i64) -> Result<Option<UndoLogRow>> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(internal)?;
        let row = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, profile_id, session_key, created_at, description, revert_sql, expires_at
                     FROM undo_log WHERE id = ?1 AND expires_at > datetime('now')",
                )
                .map_err(internal)?;
            let mut rows = stmt.query([id]).map_err(internal)?;
            match rows.next().map_err(internal)? {
                Some(r) => Some(map_undo_row(r).map_err(internal)?),
                None => None,
            }
        };
        tx.execute("DELETE FROM undo_log WHERE id = ?1", [id])
            .map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(row)
    }
}

fn map_undo_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<UndoLogRow> {
    Ok(UndoLogRow {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        session_key: r.get(2)?,
        created_at: r.get(3)?,
        description: r.get(4)?,
        revert_sql: r.get(5)?,
        expires_at: r.get(6)?,
    })
}

/// mirrored in src/ipc/types.ts
#[derive(Debug, Clone, Serialize)]
pub struct BufferSnapshot {
    pub id: i64,
    pub taken_at: String,
    pub sql: String,
}

/// Buffer time-machine storage: executed versions of a tab's editor buffer.
/// Consecutive identical snapshots dedupe; each tab keeps its newest
/// SNAPSHOT_KEEP_PER_TAB; per-row SQL capped at SNAPSHOT_SQL_CAP bytes.
impl AppDb {
    pub fn buffer_snapshot_add(&self, tab_id: &str, sql: &str) -> Result<()> {
        let sql = cap_text(sql, SNAPSHOT_SQL_CAP);
        let conn = self.0.lock().unwrap();
        let newest: Option<String> = conn
            .query_row(
                "SELECT sql FROM buffer_snapshots WHERE tab_id = ?1 ORDER BY id DESC LIMIT 1",
                [tab_id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(internal)?;
        if newest.as_deref() == Some(sql.as_ref()) {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO buffer_snapshots (tab_id, sql) VALUES (?1, ?2)",
            rusqlite::params![tab_id, sql.as_ref()],
        )
        .map_err(internal)?;
        conn.execute(
            "DELETE FROM buffer_snapshots WHERE tab_id = ?1 AND id NOT IN (
                 SELECT id FROM buffer_snapshots WHERE tab_id = ?1 ORDER BY id DESC LIMIT ?2
             )",
            rusqlite::params![tab_id, SNAPSHOT_KEEP_PER_TAB],
        )
        .map_err(internal)?;
        Ok(())
    }

    /// newest first
    pub fn buffer_snapshots_list(&self, tab_id: &str) -> Result<(Vec<BufferSnapshot>, usize)> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, taken_at, sql FROM buffer_snapshots
                 WHERE tab_id = ?1 ORDER BY id DESC",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([tab_id], |r| {
                Ok(BufferSnapshot { id: r.get(0)?, taken_at: r.get(1)?, sql: r.get(2)? })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "buffer snapshot"))
    }

    pub fn buffer_snapshots_clear(&self, tab_id: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute("DELETE FROM buffer_snapshots WHERE tab_id = ?1", [tab_id])
            .map_err(internal)?;
        Ok(())
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
        assert_eq!(db.list_profiles().unwrap().0.len(), 1);

        db.history_add("a", "select 1", 1.5, 1, HistoryStatus::Cancelled)
            .unwrap();
        let (h, skipped) = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(skipped, 0);
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
        assert_eq!(db.list_profiles().unwrap().0.len(), 1);
        assert_eq!(db.history_recent(10).unwrap().0.len(), 1);

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

        let (profiles, _) = db.list_profiles().unwrap();
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

        let (h, _) = db.history_recent(10).unwrap();
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
        assert_eq!(db.list_profiles().unwrap().0.len(), 1);
        let (h, _) = db.history_recent(10).unwrap();
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
        let (profiles, skipped) = db.list_profiles().unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(skipped, 1, "corrupt row must be counted for the UI warning");
        assert!(profiles.iter().all(|p| p.id.starts_with("good")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_tab_row_errors_history_row_skipped() {
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
        assert_eq!(db.tabs_list().unwrap().len(), 1);
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
        // tabs must ERROR, not skip — a skipped row fed back through the
        // replace-all tabs_save would permanently delete that tab's SQL
        assert!(db.tabs_list().is_err(), "corrupt tab row must surface as an error");
        let (h, skipped) = db.history_recent(10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(skipped, 1);
        assert_eq!(h[0].sql, "select 1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_sql_capped_with_marker() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        let long = "x".repeat(HISTORY_SQL_CAP + 5_000);
        db.history_add("p", &long, 1.0, 0, HistoryStatus::Ok).unwrap();
        let (h, _) = db.history_recent(1).unwrap();
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

    #[test]
    fn history_search_scans_only_newest_window() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        {
            let mut conn = db.0.lock().unwrap();
            let tx = conn.transaction().unwrap();
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO history (profile_id, sql, ms, rows, status)
                         VALUES (?1, ?2, 0, 0, 'ok')",
                    )
                    .unwrap();
                // oldest row holds the needle, then a window's worth of filler
                stmt.execute(rusqlite::params!["p", "SELECT needle_old"]).unwrap();
                for i in 0..HISTORY_SEARCH_WINDOW {
                    stmt.execute(rusqlite::params!["p", format!("filler {i}")]).unwrap();
                }
                stmt.execute(rusqlite::params!["p", "SELECT needle_new"]).unwrap();
                // a sibling profile's rows must not shrink p's window
                for i in 0..HISTORY_SEARCH_WINDOW {
                    stmt.execute(rusqlite::params!["other", format!("noise {i}")]).unwrap();
                }
            }
            tx.commit().unwrap();
        }
        // bounded: the old needle fell outside the newest-5k window
        let (hits, _) = db.history_search(Some("p"), "needle", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].sql, "SELECT needle_new");
        // profile filter applies INSIDE the window — "other" noise can't
        // starve p's rows; and the needle is found under a per-profile search
        let (hits, _) = db.history_search(Some("other"), "noise", 3).unwrap();
        assert_eq!(hits.len(), 3);
        // newest first
        assert!(hits[0].id > hits[1].id && hits[1].id > hits[2].id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pg_catalog_cache_roundtrip_and_prune() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        assert_eq!(db.pg_catalog_funcs_get("16.4").unwrap(), None);
        db.pg_catalog_funcs_put("16.4", "[{\"a\":1}]").unwrap();
        assert_eq!(
            db.pg_catalog_funcs_get("16.4").unwrap().as_deref(),
            Some("[{\"a\":1}]")
        );
        // upsert replaces
        db.pg_catalog_funcs_put("16.4", "[2]").unwrap();
        assert_eq!(db.pg_catalog_funcs_get("16.4").unwrap().as_deref(), Some("[2]"));
        // prune keeps the newest PG_CATALOG_CACHE_CAP versions
        for i in 0..(PG_CATALOG_CACHE_CAP + 3) {
            db.pg_catalog_funcs_put(&format!("v{i}"), "[]").unwrap();
        }
        let n: i64 = db
            .0
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pg_catalog_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, PG_CATALOG_CACHE_CAP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undo_log_roundtrip_take_and_prune() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        assert!(db.undo_log_latest("p").unwrap().is_none());

        let id1 = db.undo_log_add("p", "sess-1", "1 edit on public.t", "{\"a\":1}").unwrap();
        let id2 = db.undo_log_add("p", "sess-1", "2 edits on public.t", "{\"a\":2}").unwrap();
        db.undo_log_add("other", "sess-9", "noise", "{}").unwrap();
        assert!(id2 > id1);

        // only the NEWEST row per profile is offered
        let latest = db.undo_log_latest("p").unwrap().expect("latest");
        assert_eq!(latest.id, id2);
        assert_eq!(latest.session_key, "sess-1");
        assert_eq!(latest.revert_sql, "{\"a\":2}");
        assert!(!latest.expires_at.is_empty() && !latest.created_at.is_empty());

        // take is single-shot: first call returns, second is None
        let taken = db.undo_log_take(id2).unwrap().expect("take");
        assert_eq!(taken.id, id2);
        assert!(db.undo_log_take(id2).unwrap().is_none());
        // the older row surfaces next
        assert_eq!(db.undo_log_latest("p").unwrap().unwrap().id, id1);

        // expired rows are never offered and take to None
        db.0.lock()
            .unwrap()
            .execute(
                "UPDATE undo_log SET expires_at = datetime('now', '-1 minute') WHERE id = ?1",
                [id1],
            )
            .unwrap();
        assert!(db.undo_log_latest("p").unwrap().is_none());
        assert!(db.undo_log_take(id1).unwrap().is_none());

        // per-profile cap: newest UNDO_KEEP_PER_PROFILE survive, sibling untouched
        for i in 0..(UNDO_KEEP_PER_PROFILE + 5) {
            db.undo_log_add("p", "s", &format!("edit {i}"), "{}").unwrap();
        }
        let n: i64 = db
            .0
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM undo_log WHERE profile_id = 'p'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, UNDO_KEEP_PER_PROFILE);
        assert!(db.undo_log_latest("other").unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn buffer_snapshots_dedupe_cap_and_clear() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();

        db.buffer_snapshot_add("t1", "SELECT 1").unwrap();
        db.buffer_snapshot_add("t1", "SELECT 1").unwrap(); // consecutive dupe skipped
        db.buffer_snapshot_add("t1", "SELECT 2").unwrap();
        db.buffer_snapshot_add("t1", "SELECT 1").unwrap(); // non-consecutive repeat kept
        db.buffer_snapshot_add("t2", "OTHER TAB").unwrap();

        let (snaps, skipped) = db.buffer_snapshots_list("t1").unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(
            snaps.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>(),
            vec!["SELECT 1", "SELECT 2", "SELECT 1"],
            "newest first, consecutive dupe dropped"
        );
        assert!(snaps[0].id > snaps[1].id && snaps[1].id > snaps[2].id);
        assert!(!snaps[0].taken_at.is_empty());

        // per-tab cap prunes the oldest
        for i in 0..(SNAPSHOT_KEEP_PER_TAB + 10) {
            db.buffer_snapshot_add("t1", &format!("SELECT {i}")).unwrap();
        }
        let (snaps, _) = db.buffer_snapshots_list("t1").unwrap();
        assert_eq!(snaps.len(), SNAPSHOT_KEEP_PER_TAB as usize);

        // oversized SQL is capped with the marker
        let long = "y".repeat(SNAPSHOT_SQL_CAP + 100);
        db.buffer_snapshot_add("t3", &long).unwrap();
        let (snaps, _) = db.buffer_snapshots_list("t3").unwrap();
        assert!(snaps[0].sql.ends_with(HISTORY_TRUNC_MARKER));
        assert_eq!(snaps[0].sql.len(), SNAPSHOT_SQL_CAP + HISTORY_TRUNC_MARKER.len());

        // clear is per-tab
        db.buffer_snapshots_clear("t1").unwrap();
        assert!(db.buffer_snapshots_list("t1").unwrap().0.is_empty());
        assert_eq!(db.buffer_snapshots_list("t2").unwrap().0.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
