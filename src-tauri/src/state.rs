use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::appdb::AppDb;
use crate::driver::postgres::PgSession;
use crate::driver::{Profile, ProfileId, Result, SessionId};
use crate::tunnel::Tunnel;

pub struct AppState {
    pub appdb: AppDb,
    /// Arc per session so commands clone out and release the map lock before awaiting.
    pub sessions: Mutex<HashMap<SessionId, Arc<PgSession>>>,
    /// one shared SSH tunnel per profile, kept alive for the app's lifetime
    pub tunnels: Mutex<HashMap<ProfileId, Arc<Tunnel>>>,
}

impl AppState {
    pub fn new(appdb: AppDb) -> Self {
        Self {
            appdb,
            sessions: Mutex::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self, id: &str) -> Option<Arc<PgSession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Get-or-start the profile's SSH tunnel. Shared across all its sessions.
    pub async fn ensure_tunnel(&self, profile: &Profile) -> Result<Arc<Tunnel>> {
        if let Some(t) = self.tunnels.lock().unwrap().get(&profile.id).cloned() {
            return Ok(t);
        }
        // start outside the lock (std Mutex can't be held across await)
        let tunnel = Arc::new(Tunnel::start(profile).await?);
        let mut map = self.tunnels.lock().unwrap();
        // a concurrent connect may have won the race — reuse theirs, drop ours
        if let Some(t) = map.get(&profile.id).cloned() {
            return Ok(t);
        }
        map.insert(profile.id.clone(), tunnel.clone());
        Ok(tunnel)
    }
}
