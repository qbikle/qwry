//! Profile passwords live in the macOS Keychain, never in the app database.

use keyring::Entry;

use crate::driver::{DriverError, Result};

const SERVICE: &str = "app.qwry";

fn entry(profile_id: &str) -> Result<Entry> {
    Entry::new(SERVICE, profile_id)
        .map_err(|e| DriverError::Internal(format!("keychain: {e}")))
}

pub fn set_password(profile_id: &str, password: &str) -> Result<()> {
    entry(profile_id)?
        .set_password(password)
        .map_err(|e| DriverError::Internal(format!("keychain save: {e}")))
}

/// Ok(None) = no password stored for this profile (fine: connect with "");
/// Err = the Keychain itself failed, which must NOT silently become an empty
/// password ("password authentication failed" would blame the wrong thing).
pub fn get_password(profile_id: &str) -> Result<Option<String>> {
    match entry(profile_id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(DriverError::Internal(format!(
            "keychain unavailable (stored password could not be read): {e}"
        ))),
    }
}

pub fn delete_password(profile_id: &str) -> Result<()> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(DriverError::Internal(format!("keychain delete: {e}"))),
    }
}

/// Provider API keys for the agent live under `agent:<provider>` in the same
/// Keychain service (AGENT-SPEC §2.4, §8.3). The value is read only inside
/// `agent_http.rs`, on its way into an outbound request header: it never
/// crosses the IPC boundary, never enters appdb, a prompt, or the trace.
fn agent_key_id(provider: &str) -> String {
    format!("agent:{provider}")
}

pub fn set_agent_key(provider: &str, key: &str) -> Result<()> {
    set_password(&agent_key_id(provider), key)
}

/// Ok(None) = no key stored for this provider. A Keychain failure is an Err,
/// never a silent empty key (that would surface as a provider auth error and
/// blame the wrong thing).
///
/// `pub(crate)` on purpose: the key value has exactly one legitimate reader,
/// `agent_http.rs`, on its way into an outbound request header. No command
/// returns it, so it cannot cross the IPC boundary (§2.4).
pub(crate) fn get_agent_key(provider: &str) -> Result<Option<String>> {
    get_password(&agent_key_id(provider))
}

pub fn has_agent_key(provider: &str) -> Result<bool> {
    Ok(get_agent_key(provider)?.is_some())
}

pub fn delete_agent_key(provider: &str) -> Result<()> {
    delete_password(&agent_key_id(provider))
}
