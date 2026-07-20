use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::appdb::AppDb;
use crate::driver::postgres::PgSession;
use crate::driver::{Profile, ProfileId, Result, SessionId};
use crate::tunnel::Tunnel;

pub struct AppState {
    pub appdb: AppDb,
    /// true when setup refused the real appdb and managed a throwaway stub —
    /// the frontend polls this (startup_ok) and must NOT reveal the hidden
    /// window over the fatal dialog
    pub startup_fatal: bool,
    /// Arc per session so commands clone out and release the map lock before awaiting.
    pub sessions: Mutex<HashMap<SessionId, Arc<PgSession>>>,
    /// SSH tunnels keyed by SPEC (forward target + ssh params) — profiles with
    /// identical specs (e.g. DB-switcher clones onto the same server) SHARE one
    /// ssh process instead of each spawning a duplicate to the same bastion.
    pub tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// which spec each profile last connected through — lets invalidate_profile
    /// drop a tunnel only when no OTHER profile still rides it (dropping a
    /// shared tunnel would kill the sibling profiles' live sessions).
    pub profile_specs: Mutex<HashMap<ProfileId, String>>,
}

impl AppState {
    pub fn new(appdb: AppDb) -> Self {
        Self {
            appdb,
            startup_fatal: false,
            sessions: Mutex::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            profile_specs: Mutex::new(HashMap::new()),
        }
    }

    /// stub state for the refused-appdb path — IPC stays well-defined while
    /// the fatal dialog is up, but startup_ok reports the failure
    pub fn new_fatal(appdb: AppDb) -> Self {
        Self {
            startup_fatal: true,
            ..Self::new(appdb)
        }
    }

    pub fn session(&self, id: &str) -> Option<Arc<PgSession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Get-or-start the SSH tunnel for a profile's spec. Shared across every
    /// session — and every PROFILE — with the same spec. A cached tunnel is
    /// replaced when its ssh died (bastion idle / network drop); a repointed
    /// profile simply computes a different spec and gets its own tunnel, so a
    /// stale one can never keep forwarding to the old host.
    pub async fn ensure_tunnel(&self, profile: &Profile) -> Result<Arc<Tunnel>> {
        let spec = crate::tunnel::tunnel_spec(profile);
        self.profile_specs
            .lock()
            .unwrap()
            .insert(profile.id.clone(), spec.clone());
        let cached = self.tunnels.lock().unwrap().get(&spec).cloned();
        if let Some(t) = cached {
            if t.is_alive().await {
                return Ok(t);
            }
            self.tunnels.lock().unwrap().remove(&spec); // dead → restart below
        }
        // start outside the lock (std Mutex can't be held across await)
        let tunnel = Arc::new(Tunnel::start(profile).await?);
        let mut map = self.tunnels.lock().unwrap();
        // a concurrent connect may have won the race — reuse theirs, drop ours
        if let Some(t) = map.get(&spec).cloned() {
            return Ok(t);
        }
        map.insert(spec, tunnel.clone());
        Ok(tunnel)
    }

    /// A profile was repointed/invalidated: forget its spec binding and drop
    /// the tunnel ONLY if no other profile still uses that spec (refcount by
    /// enumeration — a shared tunnel must survive a sibling's invalidation).
    pub fn invalidate_profile_tunnel(&self, profile_id: &str) {
        let spec = self.profile_specs.lock().unwrap().remove(profile_id);
        if let Some(spec) = spec {
            let still_used = self
                .profile_specs
                .lock()
                .unwrap()
                .values()
                .any(|s| *s == spec);
            if !still_used {
                self.tunnels.lock().unwrap().remove(&spec);
            }
        }
    }
}
