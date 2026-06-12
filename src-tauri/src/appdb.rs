//! App-local SQLite: connection profiles (sans passwords), later query history
//! and tab state. Lives in the platform app-data dir.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::driver::{DriverError, Profile, Result};

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
             );",
        )
        .map_err(|e| DriverError::Internal(format!("appdb init: {e}")))?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM profiles ORDER BY rowid")
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
                "INSERT INTO profiles (id, data) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                rusqlite::params![profile.id, data],
            )
            .map_err(internal)?;
        Ok(())
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

fn internal(e: rusqlite::Error) -> DriverError {
    DriverError::Internal(format!("appdb: {e}"))
}
