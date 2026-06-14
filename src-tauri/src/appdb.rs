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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub created_at: String,
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
            "PRAGMA journal_mode = WAL;
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
             );",
        )
        .map_err(|e| DriverError::Internal(format!("appdb init: {e}")))?;
        // additive migrations; fail harmlessly when the column already exists
        let _ = conn.execute("ALTER TABLE tabs ADD COLUMN saved_id TEXT", []);
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
        self.0
            .lock()
            .unwrap()
            .execute("DELETE FROM profiles WHERE id = ?1", [id])
            .map_err(internal)?;
        Ok(())
    }
}

impl AppDb {
    pub fn tabs_list(&self) -> Result<Vec<TabRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, sql, position, saved_id FROM tabs ORDER BY position")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TabRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    position: r.get(3)?,
                    saved_id: r.get(4)?,
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
                "INSERT INTO tabs (id, name, sql, position, saved_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![t.id, t.name, t.sql, t.position, t.saved_id],
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
        profile_id: &str,
        query: &str,
        limit: i64,
    ) -> Result<Vec<HistoryRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, sql, ms, rows, ran_at FROM history
                 WHERE profile_id = ?1 AND sql LIKE ?2
                 ORDER BY ran_at DESC, id DESC LIMIT ?3",
            )
            .map_err(internal)?;
        let pattern = format!("%{}%", query.replace('%', "\\%"));
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
            .prepare("SELECT id, name, sql, created_at FROM saved_queries ORDER BY name")
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SavedQuery {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    created_at: r.get(3)?,
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
                "INSERT INTO saved_queries (id, name, sql) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, sql = excluded.sql",
                rusqlite::params![q.id, q.name, q.sql],
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
