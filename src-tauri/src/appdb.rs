//! App-local SQLite: connection profiles (sans passwords), query history,
//! tab state. Lives in the platform app-data dir. Schema is versioned via
//! `PRAGMA user_version`; see `migrate`.

use std::borrow::Cow;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, Value, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::driver::{DriverError, Profile, Result};

/// bump when appending a migration in `migrate`
const SCHEMA_VERSION: i64 = 8;
/// per-row stored SQL cap (bytes, cut at a char boundary): a pasted multi-MB
/// INSERT must not bloat the appdb forever
const HISTORY_SQL_CAP: usize = 20_000;
const HISTORY_TRUNC_MARKER: &str = " …[truncated]";
/// total history rows kept; the oldest beyond this are pruned on insert
const HISTORY_ROW_CAP: i64 = 20_000;
/// history_search scans only the newest N rows (per profile filter). A
/// substring LIKE can never use the btree index, so the palette's
/// per-keystroke search bounds its scan here instead of walking all 20k rows
/// (× up to 20KB of SQL each). Tradeoff, documented: matches older than the
/// newest 5k searched rows are not returned, acceptable for a
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
/// per-turn stored message cap (bytes, cut at a char boundary). Applies to the
/// turn's TEXT only: the `*_json` columns are parsed back by the trace panel,
/// so truncating them would produce unparseable JSON, and they are bounded by
/// the tool row caps (AGENT-SPEC §5) instead.
const AGENT_CONTENT_CAP: usize = 200_000;

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
    /// next saved under a connection: adopt-on-touch, mirrors tabs)
    #[serde(default)]
    pub profile_id: Option<String>,
    /// the question a `Save Query` on an answer kept: a quick-ask is a saved
    /// query that remembers what was asked, not a second kind of row (A2)
    #[serde(default)]
    pub question: Option<String>,
    /// what a check asserts about this query's shape, JSON (`CheckExpect` in
    /// src/stores/checks.ts); NULL = an ordinary saved query, not a check
    #[serde(default)]
    pub expect_json: Option<String>,
    /// what the last `Run Checks` found here, JSON (`CheckResult`); NULL until
    /// the check has run once
    #[serde(default)]
    pub last_check_json: Option<String>,
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
        // connections gone": skip and log instead of aborting the list
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
/// ALTERs: it fills exactly what's missing, re-runs nothing, and real errors
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
            6 => agent_threads_v6(&tx)?,
            7 => agent_thread_session_v7(&tx)?,
            8 => knowledge_v8(&tx)?,
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
/// `revert_sql` holds the structured revert plan (JSON, regenerated into SQL
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

/// Agent threads, turns and answers (AGENT-SPEC §9). Turns carry the model's
/// text plus the tool call/result/usage blobs as JSON, so the trace panel can
/// replay a thread with nothing summarised away (AGENT-UX §5). Answers are
/// 1:1 with the turn that produced them, hence `turn_id` as the primary key.
fn agent_threads_v6(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_threads (
             id         TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             title      TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS agent_threads_profile
             ON agent_threads (profile_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS agent_turns (
             id                INTEGER PRIMARY KEY AUTOINCREMENT,
             thread_id         TEXT NOT NULL,
             idx               INTEGER NOT NULL,
             role              TEXT NOT NULL,
             content           TEXT NOT NULL,
             tool_calls_json   TEXT,
             tool_results_json TEXT,
             usage_json        TEXT,
             model             TEXT NOT NULL,
             provider          TEXT NOT NULL,
             prompt_version    TEXT NOT NULL,
             ms                REAL NOT NULL,
             created_at        TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS agent_turns_thread ON agent_turns (thread_id, idx);
         CREATE TABLE IF NOT EXISTS agent_answers (
             turn_id          INTEGER PRIMARY KEY,
             sql              TEXT,
             row_count        INTEGER,
             assumptions_json TEXT,
             sanity_json      TEXT,
             status           TEXT NOT NULL
         );",
    )
    .map_err(internal)
}

/// The provider session a thread resumes. A cut thread (W4 jump back) cannot
/// ask `claude -p` to forget the turns it deleted, so the cut mints a fresh
/// key and the adapter resumes THAT: the thread id stays the row's identity.
/// NULL reads as the thread id, so no backfill runs over existing threads.
fn agent_thread_session_v7(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "agent_threads", "session_key", "TEXT")
}

/// What the user knows and the catalog does not (A2): a table's or column's
/// hint, the names its people call it by, and the terms this database uses.
/// `target` names the object a hint or a synonym hangs on (`table` or
/// `table.column`); a definition has no object to hang on, so its target is
/// NULL and its `term = meaning` line is the row's own text.
///
/// Saved queries gain the three columns a quick-ask and a check need: the
/// question a `Save Query` on an answer kept, the expectation a check asserts,
/// and what its last run found.
fn knowledge_v8(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_knowledge (
             id         TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             kind       TEXT NOT NULL CHECK (kind IN ('hint', 'definition', 'synonym')),
             target     TEXT,
             text       TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS agent_knowledge_profile
             ON agent_knowledge (profile_id, kind, target);",
    )
    .map_err(internal)?;
    add_column_if_missing(conn, "saved_queries", "question", "TEXT")?;
    add_column_if_missing(conn, "saved_queries", "expect_json", "TEXT")?;
    add_column_if_missing(conn, "saved_queries", "last_check_json", "TEXT")?;
    Ok(())
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

/// collect decoded rows, skipping (and logging) any that fail: one bad row
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
/// cache to the profile's connection identity: a repointed profile (different
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
/// functions are NOT cached: they stay live on every introspect.
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

    /// replace-all save: tab counts are tiny, atomicity matters more
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
        // the rowid PK; the profile filter is applied inside so a busy
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
            .prepare(
                "SELECT id, name, sql, created_at, profile_id, question, expect_json,
                        last_check_json
                 FROM saved_queries ORDER BY name",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SavedQuery {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    created_at: r.get(3)?,
                    profile_id: r.get(4)?,
                    question: r.get(5)?,
                    expect_json: r.get(6)?,
                    last_check_json: r.get(7)?,
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
                // the caller sends the whole row: src/stores/saved.ts merges an
                // upsert over the row it already holds, so a rename cannot drop
                // the question a quick-ask kept or the check on it
                "INSERT INTO saved_queries
                     (id, name, sql, profile_id, question, expect_json, last_check_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, sql = excluded.sql,
                                               profile_id = excluded.profile_id,
                                               question = excluded.question,
                                               expect_json = excluded.expect_json,
                                               last_check_json = excluded.last_check_json",
                rusqlite::params![
                    q.id,
                    q.name,
                    q.sql,
                    q.profile_id,
                    q.question,
                    q.expect_json,
                    q.last_check_json,
                ],
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
    /// structured revert plan (JSON); see driver::postgres::edit::UndoPlan
    pub revert_sql: String,
    pub expires_at: String,
}

/// Inverse-SQL undo log: one row per committed edit/delete batch, aggressively
/// pruned (15-minute TTL + newest UNDO_KEEP_PER_PROFILE per profile). Only the
/// LATEST row per profile is ever offered; a newer commit supersedes.
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

    /// newest unexpired row for a profile: the only offer ever surfaced
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

    /// read one unexpired undo row WITHOUT consuming it; undo_apply checks
    /// session identity on the peeked row FIRST and only then takes, so a
    /// refused undo never burns the offer
    pub fn undo_log_peek(&self, id: i64) -> Result<Option<UndoLogRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, session_key, created_at, description, revert_sql, expires_at
                 FROM undo_log WHERE id = ?1 AND expires_at > datetime('now')",
            )
            .map_err(internal)?;
        let mut rows = stmt.query([id]).map_err(internal)?;
        match rows.next().map_err(internal)? {
            Some(r) => Ok(Some(map_undo_row(r).map_err(internal)?)),
            None => Ok(None),
        }
    }

    /// atomically consume one undo row (select + delete in a transaction):
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

/// One Ask thread (AGENT-SPEC §9). `id` is the row's identity and the MCP
/// session's name; `session_key` is what the `claude -p` provider passes as
/// `--session-id` / `--resume`. They are the same uuid until a cut re-mints
/// the key, which is how a truncated thread gets a provider that never saw
/// the deleted turns. The column is NULL until then and reads as `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentThread {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub created_at: String,
    pub session_key: String,
}

/// One recorded turn. The `*_json` columns hold the loop's own structures
/// verbatim (tool calls, tool results, token usage) so the trace can replay
/// them; nothing here is summarised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurn {
    pub id: i64,
    pub thread_id: String,
    pub idx: i64,
    pub role: String,
    pub content: String,
    pub tool_calls_json: Option<String>,
    pub tool_results_json: Option<String>,
    pub usage_json: Option<String>,
    pub model: String,
    pub provider: String,
    pub prompt_version: String,
    pub ms: f64,
    pub created_at: String,
}

/// `AgentTurn` minus the columns the store assigns (`id`, `created_at`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnInput {
    pub thread_id: String,
    pub idx: i64,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls_json: Option<String>,
    #[serde(default)]
    pub tool_results_json: Option<String>,
    #[serde(default)]
    pub usage_json: Option<String>,
    pub model: String,
    pub provider: String,
    pub prompt_version: String,
    pub ms: f64,
}

/// What a re-run rewrites on an assistant turn already on record (W4 Restart,
/// Fix It, a chip toggle). Thread, index and role never move: the exchange
/// answers the same question in the same place, so only what the model said
/// this time is written again.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnPatch {
    pub id: i64,
    pub content: String,
    #[serde(default)]
    pub tool_calls_json: Option<String>,
    #[serde(default)]
    pub tool_results_json: Option<String>,
    #[serde(default)]
    pub usage_json: Option<String>,
    pub model: String,
    pub provider: String,
    pub prompt_version: String,
    pub ms: f64,
}

/// The answer a turn produced: its SQL, how many rows it returned, the
/// assumption chips and sanity fragments shown with it, and the verdict
/// status ("answered" | "failed" | "turn_cap" | "cancelled").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAnswer {
    pub turn_id: i64,
    pub sql: Option<String>,
    pub row_count: Option<i64>,
    #[serde(default)]
    pub assumptions_json: Option<String>,
    #[serde(default)]
    pub sanity_json: Option<String>,
    pub status: String,
}

/// Agent history (AGENT-SPEC §9). Local only: no telemetry leaves the machine
/// (ARCHITECTURE ideology 7). Deleting a thread deletes its turns and answers
/// in the same transaction, so a dropped thread leaves no orphan trace rows.
impl AppDb {
    pub fn agent_thread_create(
        &self,
        id: &str,
        profile_id: &str,
        title: &str,
    ) -> Result<AgentThread> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_threads (id, profile_id, title) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, profile_id, title],
        )
        .map_err(internal)?;
        conn.query_row(
            "SELECT id, profile_id, title, created_at, COALESCE(session_key, id)
             FROM agent_threads WHERE id = ?1",
            [id],
            |r| {
                Ok(AgentThread {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                    session_key: r.get(4)?,
                })
            },
        )
        .map_err(internal)
    }

    /// newest first; corrupt rows are skipped, never fatal to the list
    pub fn agent_threads_list(&self, profile_id: &str) -> Result<Vec<AgentThread>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, title, created_at, COALESCE(session_key, id)
                 FROM agent_threads
                 WHERE profile_id = ?1 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([profile_id], |r| {
                Ok(AgentThread {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                    session_key: r.get(4)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "agent thread").0)
    }

    pub fn agent_thread_delete(&self, id: &str) -> Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(internal)?;
        tx.execute(
            "DELETE FROM agent_answers WHERE turn_id IN
                 (SELECT id FROM agent_turns WHERE thread_id = ?1)",
            [id],
        )
        .map_err(internal)?;
        tx.execute("DELETE FROM agent_turns WHERE thread_id = ?1", [id])
            .map_err(internal)?;
        tx.execute("DELETE FROM agent_threads WHERE id = ?1", [id])
            .map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(())
    }

    /// Delete the named turns and their answers, in ONE transaction, so a
    /// failure never leaves answer rows pointing at turns that are gone.
    ///
    /// The cut names ROW IDS, never a boundary. Neither `id` nor `idx` orders
    /// a thread well enough to cut it at a position: a Retry on an older
    /// exchange that failed before the store persisted it writes its rows
    /// LAST, so the newest ids can belong to the oldest exchange on screen.
    /// The store holds each exchange's ids and says exactly which go.
    /// `thread_id` scopes it, so an id from anywhere else deletes nothing.
    pub fn agent_thread_truncate(&self, thread_id: &str, turn_ids: &[i64]) -> Result<()> {
        if turn_ids.is_empty() {
            return Ok(());
        }
        let holes = vec!["?"; turn_ids.len()].join(",");
        let mut args: Vec<Value> = Vec::with_capacity(turn_ids.len() + 1);
        args.push(Value::Text(thread_id.to_owned()));
        args.extend(turn_ids.iter().copied().map(Value::Integer));
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(internal)?;
        // the answers first: they key on the turns, which are still there
        tx.execute(
            &format!(
                "DELETE FROM agent_answers WHERE turn_id IN
                 (SELECT id FROM agent_turns WHERE thread_id = ? AND id IN ({holes}))"
            ),
            params_from_iter(args.iter()),
        )
        .map_err(internal)?;
        tx.execute(
            &format!("DELETE FROM agent_turns WHERE thread_id = ? AND id IN ({holes})"),
            params_from_iter(args.iter()),
        )
        .map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(())
    }

    /// Point the thread at a fresh provider session. A cut writes a new uuid
    /// here because a resumed `claude -p` session remembers the cut turns and
    /// cannot be rewound.
    pub fn agent_thread_session_set(&self, thread_id: &str, session_key: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "UPDATE agent_threads SET session_key = ?2 WHERE id = ?1",
                rusqlite::params![thread_id, session_key],
            )
            .map_err(internal)?;
        Ok(())
    }

    /// Move a thread's tail up the index, so a pair can be inserted between
    /// two exchanges that left it no room. The store allocates `idx` between
    /// NEIGHBOURS (a Retry on an exchange whose run failed before it persisted
    /// writes its rows after its own successors'), and when the next exchange
    /// already sits on the slots the new pair needs, this frees them first.
    ///
    /// Shift, then insert: the two are separate calls, so a failure between
    /// them leaves a gap in the thread's indices, which costs nothing, and
    /// never a collision, which costs an answer its question.
    pub fn agent_turns_shift(&self, thread_id: &str, from_idx: i64, by: i64) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "UPDATE agent_turns SET idx = idx + ?3 WHERE thread_id = ?1 AND idx >= ?2",
                rusqlite::params![thread_id, from_idx, by],
            )
            .map_err(internal)?;
        Ok(())
    }

    /// returns the new row id, which `agent_answer_put` keys on
    pub fn agent_turn_add(&self, turn: &AgentTurnInput) -> Result<i64> {
        let content = cap_text(&turn.content, AGENT_CONTENT_CAP);
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_turns
                 (thread_id, idx, role, content, tool_calls_json, tool_results_json,
                  usage_json, model, provider, prompt_version, ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                turn.thread_id,
                turn.idx,
                turn.role,
                content.as_ref(),
                turn.tool_calls_json,
                turn.tool_results_json,
                turn.usage_json,
                turn.model,
                turn.provider,
                turn.prompt_version,
                turn.ms,
            ],
        )
        .map_err(internal)?;
        Ok(conn.last_insert_rowid())
    }

    /// Rewrite a recorded assistant turn in place. A re-run that skipped this
    /// left the old prose beside the new answer row, and a reload showed an
    /// answer nobody was ever given.
    pub fn agent_turn_update(&self, turn: &AgentTurnPatch) -> Result<()> {
        let content = cap_text(&turn.content, AGENT_CONTENT_CAP);
        self.0
            .lock()
            .unwrap()
            .execute(
                "UPDATE agent_turns SET
                     content = ?2, tool_calls_json = ?3, tool_results_json = ?4,
                     usage_json = ?5, model = ?6, provider = ?7,
                     prompt_version = ?8, ms = ?9
                 WHERE id = ?1",
                rusqlite::params![
                    turn.id,
                    content.as_ref(),
                    turn.tool_calls_json,
                    turn.tool_results_json,
                    turn.usage_json,
                    turn.model,
                    turn.provider,
                    turn.prompt_version,
                    turn.ms,
                ],
            )
            .map_err(internal)?;
        Ok(())
    }

    /// A thread's turns in thread order, which is `idx`: the question's slot
    /// and its answer's one above it, allocated between the pair's neighbours
    /// (`agent_turns_shift`) and never from a position on screen. Write order
    /// (`id`) is not thread order — a Retry on an older exchange appends its
    /// rows after its own successors' — so a list read by `id` would show the
    /// retried question last and pair it with somebody else's answer.
    pub fn agent_turns_list(&self, thread_id: &str) -> Result<Vec<AgentTurn>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, thread_id, idx, role, content, tool_calls_json,
                        tool_results_json, usage_json, model, provider,
                        prompt_version, ms, created_at
                 FROM agent_turns WHERE thread_id = ?1 ORDER BY idx, id",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([thread_id], |r| {
                Ok(AgentTurn {
                    id: r.get(0)?,
                    thread_id: r.get(1)?,
                    idx: r.get(2)?,
                    role: r.get(3)?,
                    content: r.get(4)?,
                    tool_calls_json: r.get(5)?,
                    tool_results_json: r.get(6)?,
                    usage_json: r.get(7)?,
                    model: r.get(8)?,
                    provider: r.get(9)?,
                    prompt_version: r.get(10)?,
                    ms: r.get(11)?,
                    created_at: r.get(12)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "agent turn").0)
    }

    /// upsert: re-running a question's post step (a toggled assumption chip)
    /// replaces the answer rather than stacking a second row on the turn
    pub fn agent_answer_put(&self, answer: &AgentAnswer) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO agent_answers
                     (turn_id, sql, row_count, assumptions_json, sanity_json, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(turn_id) DO UPDATE SET
                     sql = excluded.sql,
                     row_count = excluded.row_count,
                     assumptions_json = excluded.assumptions_json,
                     sanity_json = excluded.sanity_json,
                     status = excluded.status",
                rusqlite::params![
                    answer.turn_id,
                    answer.sql,
                    answer.row_count,
                    answer.assumptions_json,
                    answer.sanity_json,
                    answer.status,
                ],
            )
            .map_err(internal)?;
        Ok(())
    }

    /// Every answer recorded under a thread, in the turn order the trace reads.
    /// Without this the assumption chips, sanity line and row count a reopened
    /// thread once showed would be unrecoverable: `agent_turns` carries the
    /// conversation, not the verdict.
    pub fn agent_answers_list(&self, thread_id: &str) -> Result<Vec<AgentAnswer>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT a.turn_id, a.sql, a.row_count, a.assumptions_json,
                        a.sanity_json, a.status
                 FROM agent_answers a
                 JOIN agent_turns t ON t.id = a.turn_id
                 WHERE t.thread_id = ?1
                 ORDER BY t.idx, t.id",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([thread_id], |r| {
                Ok(AgentAnswer {
                    turn_id: r.get(0)?,
                    sql: r.get(1)?,
                    row_count: r.get(2)?,
                    assumptions_json: r.get(3)?,
                    sanity_json: r.get(4)?,
                    status: r.get(5)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "agent answer").0)
    }
}

/// One thing the user told Ask about this database (A2). `kind` is checked in
/// SQL, so an unknown kind is a write error and never a row anyone reads.
/// `target` is the object a hint or a synonym hangs on (`table` or
/// `table.column`) and NULL for a definition, whose term lives in its own
/// `term = meaning` text: a definition has no object to hang on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRow {
    pub id: String,
    pub profile_id: String,
    pub kind: String,
    #[serde(default)]
    pub target: Option<String>,
    pub text: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// One question this connection already answered and the SQL that answered it,
/// for the `EARLIER ANSWERS ON THIS DATABASE:` block (A2 item 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHistoryPair {
    pub question: String,
    pub sql: String,
    pub created_at: String,
}

/// User knowledge, per connection. Local only, like every other appdb table:
/// nothing here leaves the machine except into the model's own user message.
impl AppDb {
    /// Every row for a connection, oldest first: the prompt's KNOWLEDGE block
    /// is capped and drops the oldest first, so age is the order it wants.
    pub fn agent_knowledge_list(&self, profile_id: &str) -> Result<Vec<KnowledgeRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, kind, target, text, created_at, updated_at
                 FROM agent_knowledge WHERE profile_id = ?1
                 ORDER BY created_at, rowid",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([profile_id], |r| {
                Ok(KnowledgeRow {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    kind: r.get(2)?,
                    target: r.get(3)?,
                    text: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "knowledge row").0)
    }

    /// Upsert by id. `created_at` stays what the row was born with; editing a
    /// hint in place is an edit, not a new fact.
    pub fn agent_knowledge_upsert(&self, row: &KnowledgeRow) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO agent_knowledge (id, profile_id, kind, target, text)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind,
                                               target = excluded.target,
                                               text = excluded.text,
                                               updated_at = datetime('now')",
                rusqlite::params![row.id, row.profile_id, row.kind, row.target, row.text],
            )
            .map_err(internal)?;
        Ok(())
    }

    pub fn agent_knowledge_delete(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute("DELETE FROM agent_knowledge WHERE id = ?1", [id])
            .map_err(internal)?;
        Ok(())
    }

    /// The connection's answered questions and their SQL, newest first. An
    /// exchange is a pair of turns, the question at `idx` and its answer one
    /// above it (see `agent_turns_list`), so the question is joined by that
    /// neighbour and not by write order, which a retry does not follow. Only
    /// answered turns that landed SQL qualify: a failed run has nothing to
    /// show a later question.
    pub fn agent_history_pairs(
        &self,
        profile_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentHistoryPair>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT q.content, a.sql, t.created_at
                 FROM agent_answers a
                 JOIN agent_turns t ON t.id = a.turn_id
                 JOIN agent_threads th ON th.id = t.thread_id
                 JOIN agent_turns q ON q.thread_id = t.thread_id
                                   AND q.idx = t.idx - 1
                                   AND q.role = 'user'
                 WHERE th.profile_id = ?1 AND a.status = 'answered' AND a.sql IS NOT NULL
                 ORDER BY t.created_at DESC, t.id DESC
                 LIMIT ?2",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map(rusqlite::params![profile_id, limit], |r| {
                Ok(AgentHistoryPair {
                    question: r.get(0)?,
                    sql: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })
            .map_err(internal)?;
        Ok(collect_ok(rows, "agent history pair").0)
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
        // tabs must ERROR, not skip: a skipped row fed back through the
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
        // profile filter applies INSIDE the window: "other" noise can't
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

    #[test]
    fn agent_thread_turns_answers_roundtrip_and_cascade() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();

        let thread = db.agent_thread_create("th-1", "p1", "Top films").unwrap();
        assert_eq!(thread.profile_id, "p1");
        db.agent_thread_create("th-2", "p2", "Other connection").unwrap();
        let mine = db.agent_threads_list("p1").unwrap();
        assert_eq!(mine.len(), 1, "threads are scoped to their connection");

        let turn = AgentTurnInput {
            thread_id: "th-1".into(),
            idx: 0,
            role: "assistant".into(),
            content: "SELECT 1".into(),
            tool_calls_json: Some("[]".into()),
            tool_results_json: None,
            usage_json: Some(r#"{"input":10,"output":2}"#.into()),
            model: "claude-haiku-4-5".into(),
            provider: "claude-code".into(),
            prompt_version: "v1".into(),
            ms: 12.5,
        };
        let turn_id = db.agent_turn_add(&turn).unwrap();
        let turns = db.agent_turns_list("th-1").unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].usage_json.as_deref(), Some(r#"{"input":10,"output":2}"#));

        let answer = AgentAnswer {
            turn_id,
            sql: Some("SELECT 1".into()),
            row_count: Some(1),
            assumptions_json: Some("[]".into()),
            sanity_json: None,
            status: "answered".into(),
        };
        db.agent_answer_put(&answer).unwrap();
        // second put replaces, never stacks (a toggled assumption chip re-runs)
        db.agent_answer_put(&AgentAnswer { row_count: Some(2), ..answer }).unwrap();
        let n: i64 = {
            let conn = db.0.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM agent_answers", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(n, 1);

        // a reopened thread reads its verdict back, scoped to that thread
        let read_back = db.agent_answers_list("th-1").unwrap();
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].turn_id, turn_id);
        assert_eq!(read_back[0].row_count, Some(2));
        assert!(db.agent_answers_list("th-2").unwrap().is_empty());

        db.agent_thread_delete("th-1").unwrap();
        assert!(db.agent_threads_list("p1").unwrap().is_empty());
        assert!(db.agent_turns_list("th-1").unwrap().is_empty());
        let orphans: i64 = {
            let conn = db.0.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM agent_answers", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(orphans, 0, "deleting a thread leaves no orphan answer rows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_thread_truncate_cuts_turns_answers_and_remints_the_session() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();

        let thread = db.agent_thread_create("th-1", "p1", "Jump back").unwrap();
        // NULL reads as the thread id: no backfill runs over existing threads
        assert_eq!(thread.session_key, "th-1");
        db.agent_thread_create("th-2", "p1", "Untouched").unwrap();

        let ids: Vec<i64> = (0..6).map(|idx| answered(&db, "th-1", idx)).collect();
        let other = answered(&db, "th-2", 0);

        // the cut names the four rows the last two exchanges own, and one row
        // of another thread, which it must not touch
        let mut cut = ids[2..].to_vec();
        cut.push(other);
        db.agent_thread_truncate("th-1", &cut).unwrap();
        let kept = db.agent_turns_list("th-1").unwrap();
        assert_eq!(kept.len(), 2, "the named turns are gone");
        assert_eq!(kept.iter().map(|t| t.idx).collect::<Vec<_>>(), vec![0, 1]);
        let answers = db.agent_answers_list("th-1").unwrap();
        assert_eq!(answers.len(), 2, "the kept turns keep their answers");
        // the cut is scoped to its thread, answer rows included
        assert_eq!(db.agent_turns_list("th-2").unwrap().len(), 1);
        assert_eq!(db.agent_answers_list("th-2").unwrap().len(), 1);
        let orphans: i64 = {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM agent_answers a
                 LEFT JOIN agent_turns t ON t.id = a.turn_id WHERE t.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(orphans, 0, "a cut leaves no orphan answer rows");

        db.agent_thread_session_set("th-1", "fresh-uuid").unwrap();
        let listed = db.agent_threads_list("p1").unwrap();
        let mine = listed.iter().find(|t| t.id == "th-1").unwrap();
        assert_eq!(mine.session_key, "fresh-uuid");
        // the re-mint is per thread; the other thread still resumes its own id
        let other = listed.iter().find(|t| t.id == "th-2").unwrap();
        assert_eq!(other.session_key, "th-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Write order is not thread order: a Retry on an older exchange that had
    /// failed before the store persisted it writes its rows LAST, so the
    /// newest ids belong to the second question of three. A cut that read a
    /// boundary out of `id` (or a row count) would keep the exchange it was
    /// asked to delete and delete the one before it.
    #[test]
    fn agent_thread_truncate_and_list_survive_rows_written_out_of_order() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.agent_thread_create("th-late", "p1", "A late retry").unwrap();

        let q1 = [answered(&db, "th-late", 0), answered(&db, "th-late", 1)];
        // the second question's provider failed: no rows at all
        let q3 = [answered(&db, "th-late", 4), answered(&db, "th-late", 5)];
        // …then the user retried it, and it landed after its own successor
        let q2 = [answered(&db, "th-late", 2), answered(&db, "th-late", 3)];
        assert!(q2[0] > q3[1], "the retry owns the newest ids");

        // a reload reads the three exchanges in the order they are on screen
        let listed = db.agent_turns_list("th-late").unwrap();
        assert_eq!(
            listed.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![q1[0], q1[1], q2[0], q2[1], q3[0], q3[1]],
        );

        // jumping back to the third question cuts THAT exchange, not the last
        // two rows written
        db.agent_thread_truncate("th-late", &q3).unwrap();

        let kept = db.agent_turns_list("th-late").unwrap();
        assert_eq!(
            kept.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![q1[0], q1[1], q2[0], q2[1]],
            "the retried exchange survives its successor's cut"
        );
        assert_eq!(db.agent_answers_list("th-late").unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pair is placed between its neighbours, so an exchange whose retry
    /// lands between two that left it no room shifts the tail up first. The
    /// rows keep their ids and their answers: only the slot moves.
    #[test]
    fn agent_turns_shift_frees_a_slot_and_leaves_other_threads_alone() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.agent_thread_create("th-shift", "p1", "A retry").unwrap();
        db.agent_thread_create("th-other", "p1", "Untouched").unwrap();

        // the first exchange at 0,1 and the third at 4,5: the second failed
        // before it persisted, and its Retry needs 4,5 for itself
        let ids: Vec<i64> = [0i64, 1, 4, 5]
            .into_iter()
            .map(|idx| answered(&db, "th-shift", idx))
            .collect();
        let other = answered(&db, "th-other", 4);

        db.agent_turns_shift("th-shift", 4, 2).unwrap();

        let rows = db.agent_turns_list("th-shift").unwrap();
        assert_eq!(
            rows.iter().map(|t| t.idx).collect::<Vec<_>>(),
            vec![0, 1, 6, 7],
            "the tail moves up, the rows below it stand"
        );
        assert_eq!(
            rows.iter().map(|t| t.id).collect::<Vec<_>>(),
            ids,
            "the same rows in the same order: a shift is not a rewrite"
        );
        assert_eq!(db.agent_answers_list("th-shift").unwrap().len(), 4);
        // scoped to its thread, like every other write here
        let untouched = db.agent_turns_list("th-other").unwrap();
        assert_eq!(untouched.len(), 1);
        assert_eq!(untouched[0].id, other);
        assert_eq!(untouched[0].idx, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// one turn with a verdict on it; returns the turn's row id
    fn answered(db: &AppDb, thread_id: &str, idx: i64) -> i64 {
        let id = db.agent_turn_add(&turn(thread_id, idx)).unwrap();
        db.agent_answer_put(&AgentAnswer {
            turn_id: id,
            sql: Some("SELECT 1".into()),
            row_count: Some(1),
            assumptions_json: None,
            sanity_json: None,
            status: "answered".into(),
        })
        .unwrap();
        id
    }

    #[test]
    fn agent_turn_update_rewrites_what_the_rerun_said() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.agent_thread_create("th-up", "p1", "Restart").unwrap();
        let id = db.agent_turn_add(&turn("th-up", 1)).unwrap();

        db.agent_turn_update(&AgentTurnPatch {
            id,
            content: "the second answer".into(),
            tool_calls_json: Some("[]".into()),
            tool_results_json: Some("[]".into()),
            usage_json: Some("{\"input\":9}".into()),
            model: "claude-sonnet-5".into(),
            provider: "claude-code".into(),
            prompt_version: "v2".into(),
            ms: 42.0,
        })
        .unwrap();

        let rows = db.agent_turns_list("th-up").unwrap();
        assert_eq!(rows.len(), 1, "a rewrite is not a second turn");
        assert_eq!(rows[0].content, "the second answer");
        assert_eq!(rows[0].usage_json.as_deref(), Some("{\"input\":9}"));
        assert_eq!(rows[0].model, "claude-sonnet-5");
        assert_eq!(rows[0].prompt_version, "v2");
        assert_eq!(rows[0].ms, 42.0);
        // the row keeps its place in the thread
        assert_eq!(rows[0].idx, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn turn(thread_id: &str, idx: i64) -> AgentTurnInput {
        AgentTurnInput {
            thread_id: thread_id.into(),
            idx,
            role: if idx % 2 == 0 { "user" } else { "assistant" }.into(),
            content: format!("turn {idx}"),
            tool_calls_json: None,
            tool_results_json: None,
            usage_json: None,
            model: "claude-haiku-4-5".into(),
            provider: "claude-code".into(),
            prompt_version: "v1".into(),
            ms: 1.0,
        }
    }

    fn knowledge(
        id: &str,
        profile_id: &str,
        kind: &str,
        target: Option<&str>,
        text: &str,
    ) -> KnowledgeRow {
        KnowledgeRow {
            id: id.into(),
            profile_id: profile_id.into(),
            kind: kind.into(),
            target: target.map(str::to_string),
            text: text.into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn knowledge_rows_are_scoped_upserted_in_place_and_deleted() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();

        db.agent_knowledge_upsert(&knowledge("k1", "p1", "hint", Some("order_v2"), "Checkout attempts"))
            .unwrap();
        db.agent_knowledge_upsert(&knowledge("k2", "p1", "synonym", Some("order_v2"), "purchases"))
            .unwrap();
        db.agent_knowledge_upsert(&knowledge("k3", "p1", "definition", None, "AOV = revenue over orders"))
            .unwrap();
        db.agent_knowledge_upsert(&knowledge("k4", "p2", "hint", Some("order_v2"), "Another connection"))
            .unwrap();

        let rows = db.agent_knowledge_list("p1").unwrap();
        assert_eq!(rows.len(), 3, "knowledge belongs to its connection");
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["k1", "k2", "k3"],
            "oldest first: the prompt's block drops the oldest first"
        );
        assert_eq!(rows[2].target, None, "a definition hangs on no object");

        // editing a hint in place is an edit, not a second fact
        let born = rows[0].created_at.clone();
        db.agent_knowledge_upsert(&knowledge("k1", "p1", "hint", Some("order_v2"), "Failed ones stay"))
            .unwrap();
        let rows = db.agent_knowledge_list("p1").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].text, "Failed ones stay");
        assert_eq!(rows[0].created_at, born, "an edit keeps the row's age, and its place");

        db.agent_knowledge_delete("k2").unwrap();
        let rows = db.agent_knowledge_list("p1").unwrap();
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["k1", "k3"]);
        assert_eq!(db.agent_knowledge_list("p2").unwrap().len(), 1, "a delete is scoped to its row");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knowledge_kind_is_checked_in_sql() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        assert!(
            db.agent_knowledge_upsert(&knowledge("k1", "p1", "note", None, "x")).is_err(),
            "an unknown kind is a write error, never a row someone reads"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The db this migration meets in the wild: everything the previous
    /// version wrote, none of what this one adds. Built by taking a current db
    /// back one version rather than by hand, so the test says nothing about
    /// which number this migration lands on (the merge renumbers it).
    #[test]
    fn migration_adds_the_knowledge_table_and_the_saved_columns() {
        let dir = tmp_dir();
        {
            let db = AppDb::open(&dir).unwrap();
            db.saved_upsert(&SavedQuery {
                id: "s1".into(),
                name: "Unpaid orders".into(),
                sql: "SELECT 1".into(),
                created_at: String::new(),
                profile_id: Some("p1".into()),
                question: Some("which orders are unpaid?".into()),
                expect_json: Some("{\"kind\":\"nonempty\"}".into()),
                last_check_json: None,
            })
            .unwrap();
        }
        {
            let conn = Connection::open(dir.join("qwry.sqlite")).unwrap();
            conn.execute_batch(
                "DROP TABLE agent_knowledge;
                 ALTER TABLE saved_queries DROP COLUMN question;
                 ALTER TABLE saved_queries DROP COLUMN expect_json;
                 ALTER TABLE saved_queries DROP COLUMN last_check_json;",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1).unwrap();
        }

        let db = AppDb::open(&dir).unwrap();
        assert_eq!(user_version(&db), SCHEMA_VERSION);

        let (saved, skipped) = db.saved_list().unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(saved.len(), 1, "the bookmark survives the columns it never had");
        assert_eq!(saved[0].name, "Unpaid orders");
        assert_eq!(saved[0].question, None, "a bookmark from before is no quick-ask");
        assert_eq!(saved[0].expect_json, None);

        db.agent_knowledge_upsert(&knowledge("k1", "p1", "hint", Some("order_v2"), "Attempts"))
            .unwrap();
        assert_eq!(db.agent_knowledge_list("p1").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_query_keeps_its_question_and_check_across_a_reload() {
        let dir = tmp_dir();
        {
            let db = AppDb::open(&dir).unwrap();
            db.saved_upsert(&SavedQuery {
                id: "s1".into(),
                name: "Unpaid orders older than a week".into(),
                sql: "SELECT 1".into(),
                created_at: String::new(),
                profile_id: Some("p1".into()),
                question: Some("which orders are still unpaid after a week?".into()),
                expect_json: Some("{\"kind\":\"rows\",\"op\":\"eq\",\"n\":0}".into()),
                last_check_json: Some("{\"ok\":false,\"rows\":12,\"scalar\":null,\"at\":\"t\"}".into()),
            })
            .unwrap();
        }
        let db = AppDb::open(&dir).unwrap();
        let (saved, _) = db.saved_list().unwrap();
        assert_eq!(saved[0].question.as_deref(), Some("which orders are still unpaid after a week?"));
        assert_eq!(saved[0].expect_json.as_deref(), Some("{\"kind\":\"rows\",\"op\":\"eq\",\"n\":0}"));
        assert!(saved[0].last_check_json.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One exchange: the question at `idx` and its answer one above it, which
    /// is the pairing `agent_history_pairs` joins on.
    fn exchange(
        db: &AppDb,
        thread_id: &str,
        idx: i64,
        question: &str,
        sql: Option<&str>,
        status: &str,
    ) {
        db.agent_turn_add(&AgentTurnInput { content: question.into(), ..turn(thread_id, idx) })
            .unwrap();
        let id = db.agent_turn_add(&turn(thread_id, idx + 1)).unwrap();
        db.agent_answer_put(&AgentAnswer {
            turn_id: id,
            sql: sql.map(str::to_string),
            row_count: Some(1),
            assumptions_json: None,
            sanity_json: None,
            status: status.into(),
        })
        .unwrap();
    }

    #[test]
    fn agent_history_pairs_newest_first_limited_and_scoped() {
        let dir = tmp_dir();
        let db = AppDb::open(&dir).unwrap();
        db.agent_thread_create("th-1", "p1", "Revenue").unwrap();
        db.agent_thread_create("th-2", "p1", "More revenue").unwrap();
        db.agent_thread_create("th-3", "p2", "Another connection").unwrap();

        exchange(&db, "th-1", 0, "how many orders last month?", Some("SELECT 1"), "answered");
        exchange(&db, "th-1", 2, "and the failed ones?", None, "failed");
        exchange(&db, "th-1", 4, "what did they spend?", Some("SELECT 2"), "answered");
        // a turn cap left SQL on record but never answered with it
        exchange(&db, "th-2", 0, "who bought twice?", Some("SELECT 3"), "turn_cap");
        exchange(&db, "th-2", 2, "how many signed up?", Some("SELECT 4"), "answered");
        exchange(&db, "th-3", 0, "not this connection", Some("SELECT 5"), "answered");

        let pairs = db.agent_history_pairs("p1", 10).unwrap();
        assert_eq!(
            pairs.iter().map(|p| p.question.as_str()).collect::<Vec<_>>(),
            vec!["how many signed up?", "what did they spend?", "how many orders last month?"],
            "newest first; a failed run and a capped one have nothing to show"
        );
        assert_eq!(pairs[0].sql, "SELECT 4", "the SQL is the answer's, not the question's");
        assert!(!pairs[0].created_at.is_empty());

        let three = db.agent_history_pairs("p1", 1).unwrap();
        assert_eq!(three.len(), 1, "the limit is the caller's");
        assert_eq!(three[0].question, "how many signed up?");

        let other = db.agent_history_pairs("p2", 10).unwrap();
        assert_eq!(other.len(), 1, "history belongs to its connection");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
