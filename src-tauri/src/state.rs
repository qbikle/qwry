use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::appdb::AppDb;
use crate::driver::postgres::PgSession;
use crate::driver::SessionId;

pub struct AppState {
    pub appdb: AppDb,
    /// Arc per session so commands clone out and release the map lock before awaiting.
    pub sessions: Mutex<HashMap<SessionId, Arc<PgSession>>>,
}

impl AppState {
    pub fn new(appdb: AppDb) -> Self {
        Self {
            appdb,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self, id: &str) -> Option<Arc<PgSession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
}
