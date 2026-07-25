//! SSH tunnels via the system `ssh` binary. We spawn `ssh -N -L …` (so it
//! honours ~/.ssh/config: keys, ProxyJump, host aliases) and connect Postgres
//! to the local forwarded port. One tunnel per profile, shared across that
//! profile's sessions; `kill_on_drop` reaps the child when the tunnel is freed.
//!
//! Each tunnel is TWO ssh processes to the same destination: the data lane
//! (all session traffic) and a control lane. One ssh process is one TCP
//! connection, so a bulk SELECT saturating the data lane queues any NEW
//! connection's handshake behind buffered row bytes, and Postgres cancel
//! REQUIRES a new connection. The control lane is a separate process =
//! separate TCP connection, so cancel/terminate signals get through no matter
//! how congested the data lane is. A failed control spawn degrades gracefully
//! (cancel falls back to the data lane); it never blocks connecting.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use crate::driver::{DriverError, Profile, Result};

pub struct Tunnel {
    pub local_port: u16,
    /// control-lane forwarded port (own ssh process); None = the control
    /// spawn failed and cancel shares the data lane (pre-control behavior)
    pub control_port: Option<u16>,
    // kept alive for the tunnel's lifetime; kill_on_drop reaps ssh on drop
    _child: Child,
    _control_child: Option<Child>,
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

/// two distinct free ports: both listeners are held simultaneously so the
/// kernel cannot hand the same port to both lanes
fn free_local_ports() -> Result<(u16, u16)> {
    let bind = || {
        std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| DriverError::Connect(format!("tunnel: no local port: {e}")))
    };
    let (a, b) = (bind()?, bind()?);
    let port = |l: &std::net::TcpListener| {
        l.local_addr()
            .map(|a| a.port())
            .map_err(|e| DriverError::Connect(format!("tunnel: {e}")))
    };
    Ok((port(&a)?, port(&b)?))
}

/// spawn one `ssh -N -L` forward and wait until its local port accepts.
/// The control lane opts out of ControlMaster multiplexing: a user's
/// `ControlMaster auto` in ~/.ssh/config would otherwise fold both lanes
/// back onto ONE shared TCP connection, defeating the second lane entirely.
async fn spawn_forward(
    profile: &Profile,
    ssh_host: &str,
    local_port: u16,
    control: bool,
) -> Result<Child> {
    let mut cmd = Command::new("ssh");
    cmd.arg("-N") // no remote command, just forward
        .arg("-T")
        .args(["-o", "BatchMode=yes"]) // never prompt: fail instead of hanging
        .args(["-o", "ExitOnForwardFailure=yes"])
        .args(["-o", "ServerAliveInterval=30"])
        .args(["-o", "ServerAliveCountMax=3"])
        .args(["-o", "StrictHostKeyChecking=accept-new"]);
    if control {
        cmd.args(["-o", "ControlMaster=no"])
            .args(["-o", "ControlPath=none"]);
    }
    cmd.arg("-L").arg(format!(
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
        Ok(()) => Ok(child),
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
        let (data_port, control_port) = free_local_ports()?;

        // both lanes concurrently: the control spawn must not double connect
        // latency, and a control failure must never block connecting
        let (data, control) = tokio::join!(
            spawn_forward(profile, ssh_host, data_port, false),
            spawn_forward(profile, ssh_host, control_port, true),
        );
        // data lane is the tunnel; a control child from a failed data spawn
        // is dropped here and reaped by kill_on_drop
        let child = data?;
        let (control_port, control_child) = match control {
            Ok(c) => (Some(control_port), Some(c)),
            Err(e) => {
                eprintln!("tunnel: control lane unavailable ({e}); cancel will share the data lane");
                (None, None)
            }
        };
        Ok(Tunnel {
            local_port: data_port,
            control_port,
            _child: child,
            _control_child: control_child,
        })
    }
}

async fn wait_ready(port: u16, child: &mut Child) -> Result<()> {
    // ~10s budget; poll fast at first (a warm ControlMaster/localhost forward
    // is up in <50ms; a fixed 200ms quantum wasted most of that), backing off
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
