//! Profile passwords live in the macOS Keychain — never in the app database.

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

pub fn get_password(profile_id: &str) -> Result<String> {
    entry(profile_id)?
        .get_password()
        .map_err(|e| DriverError::Internal(format!("keychain read: {e}")))
}

pub fn delete_password(profile_id: &str) -> Result<()> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(DriverError::Internal(format!("keychain delete: {e}"))),
    }
}
