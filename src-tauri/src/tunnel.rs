//! SSH tunnels via the system `ssh` binary. We spawn `ssh -N -L …` (so it
//! honours ~/.ssh/config: keys, ProxyJump, host aliases) and connect Postgres
//! to the local forwarded port. One tunnel per profile, shared across that
//! profile's sessions; `kill_on_drop` reaps the child when the tunnel is freed.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use crate::driver::{DriverError, Profile, Result};

pub struct Tunnel {
    pub local_port: u16,
    // kept alive for the tunnel's lifetime; kill_on_drop reaps ssh on drop
    _child: Child,
}

/// A profile uses a tunnel when it has a non-empty ssh host.
pub fn tunnel_host(profile: &Profile) -> Option<&str> {
    profile
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
}

/// identity of a profile's tunnel: forward target + ssh connection params
pub fn tunnel_spec(p: &Profile) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        p.host,
        p.port,
        p.ssh_host.as_deref().unwrap_or(""),
        p.ssh_port.unwrap_or(0),
        p.ssh_user.as_deref().unwrap_or(""),
        p.ssh_key.as_deref().unwrap_or(""),
    )
}

fn free_local_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| DriverError::Connect(format!("tunnel: no local port: {e}")))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| DriverError::Connect(format!("tunnel: {e}")))
}

impl Tunnel {
    /// is the forward still up? (ssh died / bastion dropped → local port closed)
    pub async fn is_alive(&self) -> bool {
        tokio::time::timeout(
            Duration::from_millis(800),
            tokio::net::TcpStream::connect(("127.0.0.1", self.local_port)),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    }

    pub async fn start(profile: &Profile) -> Result<Tunnel> {
        let ssh_host = tunnel_host(profile)
            .ok_or_else(|| DriverError::Connect("tunnel: no ssh host".into()))?;
        let local_port = free_local_port()?;

        let mut cmd = Command::new("ssh");
        cmd.arg("-N") // no remote command, just forward
            .arg("-T")
            .args(["-o", "BatchMode=yes"]) // never prompt — fail instead of hanging
            .args(["-o", "ExitOnForwardFailure=yes"])
            .args(["-o", "ServerAliveInterval=30"])
            .args(["-o", "ServerAliveCountMax=3"])
            .args(["-o", "StrictHostKeyChecking=accept-new"])
            .arg("-L")
            .arg(format!(
                "127.0.0.1:{local_port}:{}:{}",
                profile.host, profile.port
            ));

        if let Some(port) = profile.ssh_port {
            if port != 0 {
                cmd.args(["-p", &port.to_string()]);
            }
        }
        if let Some(key) = profile.ssh_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            cmd.args(["-i", key]);
        }

        // user@host, or just the host (so ~/.ssh/config can supply the user)
        let target = match profile.ssh_user.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(user) => format!("{user}@{ssh_host}"),
            None => ssh_host.to_string(),
        };
        cmd.arg(target);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| DriverError::Connect(format!("tunnel: failed to spawn ssh: {e}")))?;

        // wait until the local port accepts connections (or ssh dies / times out)
        match wait_ready(local_port, &mut child).await {
            Ok(()) => Ok(Tunnel {
                local_port,
                _child: child,
            }),
            Err(e) => {
                // surface ssh's own complaint if it exited
                let mut buf = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut buf).await;
                }
                let _ = child.start_kill();
                let detail = buf.trim();
                if detail.is_empty() {
                    Err(e)
                } else {
                    Err(DriverError::Connect(format!("tunnel: {detail}")))
                }
            }
        }
    }
}

async fn wait_ready(port: u16, child: &mut Child) -> Result<()> {
    // ~10s budget; poll fast at first (a warm ControlMaster/localhost forward
    // is up in <50ms — a fixed 200ms quantum wasted most of that), backing off
    // toward 200ms for the slow-bastion case
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut delay = Duration::from_millis(25);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(DriverError::Connect(format!(
                "tunnel: ssh exited early ({status})"
            )));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() + delay >= deadline {
            return Err(DriverError::Connect(
                "tunnel: timed out waiting for the forwarded port".into(),
            ));
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(200));
    }
}
