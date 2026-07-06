//! App-local SQLite: connection profiles (sans passwords), later query history
//! and tab state. Lives in the platform app-data dir.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::driver::{DriverError, Profile, Result};

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

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    pub id: i64,
    pub profile_id: String,
    pub sql: String,
    pub ms: f64,
    pub rows: i64,
    pub ran_at: String,
}

pub struct AppDb(Mutex<Connection>);

impl AppDb {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| DriverError::Internal(format!("appdb dir: {e}")))?;
        let conn = Connection::open(dir.join("qwry.sqlite"))
            .map_err(|e| DriverError::Internal(format!("appdb open: {e}")))?;
        conn.execute_batch(
            "PRAGMA busy_timeout = 2000;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS profiles (
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
        .map_err(|e| DriverError::Internal(format!("appdb init: {e}")))?;
        // additive migrations; fail harmlessly when the column already exists
        let _ = conn.execute("ALTER TABLE tabs ADD COLUMN saved_id TEXT", []);
        let _ = conn.execute("ALTER TABLE tabs ADD COLUMN profile_id TEXT", []);
        let _ = conn.execute("ALTER TABLE saved_queries ADD COLUMN profile_id TEXT", []);
        let _ = conn.execute("ALTER TABLE profiles ADD COLUMN position INTEGER", []);
        let _ = conn.execute("UPDATE profiles SET position = rowid WHERE position IS NULL", []);
        Ok(Self(Mutex::new(conn)))
    }

    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM profiles ORDER BY position, rowid")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(internal)?;
        let mut out = Vec::new();
        for data in rows {
            let data = data.map_err(internal)?;
            let profile: Profile = serde_json::from_str(&data)
                .map_err(|e| DriverError::Internal(format!("profile parse: {e}")))?;
            out.push(profile);
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
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(internal)
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

    pub fn history_add(&self, profile_id: &str, sql: &str, ms: f64, rows: i64) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO history (profile_id, sql, ms, rows) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![profile_id, sql, ms, rows],
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
                "SELECT id, profile_id, sql, ms, rows, ran_at FROM history
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
            .query_map(rusqlite::params![profile_id, pattern, limit], |r| {
                Ok(HistoryRow {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    sql: r.get(2)?,
                    ms: r.get(3)?,
                    rows: r.get(4)?,
                    ran_at: r.get(5)?,
                })
            })
            .map_err(internal)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(internal)
    }

    /// most recent queries across all profiles (for the home dashboard)
    pub fn history_recent(&self, limit: i64) -> Result<Vec<HistoryRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, sql, ms, rows, ran_at FROM history
                 ORDER BY ran_at DESC, id DESC LIMIT ?1",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(HistoryRow {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    sql: r.get(2)?,
                    ms: r.get(3)?,
                    rows: r.get(4)?,
                    ran_at: r.get(5)?,
                })
            })
            .map_err(internal)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(internal)
    }
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
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(internal)
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
