//! The `claude -p` child process (AGENT-SPEC §7 adapter 3; W0 §12).
//!
//! Direct exec through `tokio::process`, never a shell: the system prompt and
//! the candidate-tables block are arbitrary text and must not be re-parsed by
//! anything on the way to the child. The prompt goes on stdin for the same
//! reason (that, and argv length limits). Stdout is `--output-format
//! stream-json`, one JSON object per line, relayed verbatim over the channel;
//! this module frames lines and nothing else, the adapter parses them.
//!
//! Flags are the TypeScript adapter's business, with one exception that is
//! law rather than preference (measured in W0, every one of these was needed):
//! `--tools ""` (else 26 built-ins are reachable), `--allowedTools
//! 'mcp__qwry__*'` (else every MCP call is permission-denied and the model
//! gives up silently), `--setting-sources ""` (else the user's own hooks and
//! CLAUDE.md inject context qwry never sent), `--strict-mcp-config
//! --mcp-config <inline JSON>`, `--output-format stream-json --verbose
//! --include-partial-messages`, `--system-prompt`, `--max-turns`, and
//! `--session-id <thread uuid>` on the first call / `--resume <thread uuid>`
//! after. Do NOT pass `--exclude-dynamic-system-prompt-sections` (a no-op
//! once `--system-prompt` is set) or `--bare` (it needs an API key).
//!
//! A dead MCP server is NOT an error here: `claude -p` exits 0 with
//! `system/init.mcp_servers[].status == "failed"`, zero tools, and a model
//! free to hallucinate. The adapter must treat any status other than
//! `"connected"` as a hard failure before the first model turn.
//!
//! Cancellation is by caller-minted `run_id` (same reasoning as
//! `agent_http.rs`): ⌘. kills the child, SIGKILL after a grace period.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::driver::{DriverError, Result};

/// bytes of stderr kept for the failure message; a CLI crash dump must not
/// become an unbounded string in a Tauri response
pub const STDERR_TAIL_CAP: usize = 4_000;
/// grace period between SIGTERM and SIGKILL on `agent_claude_kill`
pub const KILL_GRACE_MS: u64 = 2_000;

/// Install locations searched after `PATH`. A packaged app launched by launchd
/// inherits a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), which is never
/// where `claude` lands, so PATH alone would report "not found" on a machine
/// where the CLI works perfectly in a terminal.
const EXTRA_INSTALL_DIRS: [&str; 3] = [".local/bin", "/opt/homebrew/bin", "/usr/local/bin"];

/// How a `claude -p` invocation ended. `code` is `None` when the child was
/// signalled (the ⌘. path).
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeExit {
    pub run_id: String,
    pub code: Option<i32>,
    /// last `STDERR_TAIL_CAP` bytes of stderr, for the error register
    pub stderr_tail: String,
    pub ms: f64,
}

/// A live child, addressable from `agent_claude_kill`. `reaped` is cancelled
/// the moment the child is waited on, which is what stops the SIGKILL
/// escalation from landing on a pid the OS has already recycled.
#[derive(Debug, Clone)]
struct RunHandle {
    pid: u32,
    reaped: CancellationToken,
}

fn running() -> &'static Mutex<HashMap<String, RunHandle>> {
    static MAP: OnceLock<Mutex<HashMap<String, RunHandle>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deregisters a run on every exit path and releases the escalation task.
struct RunGuard {
    run_id: String,
    reaped: CancellationToken,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = running().lock() {
            map.remove(&self.run_id);
        }
        self.reaped.cancel();
    }
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `PATH` first, then the two locations the CLI's own installers use. Returns
/// the resolved path so the spawn is an absolute exec, not a `PATH` lookup the
/// child's cleared environment could no longer perform.
fn resolve_claude() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude");
            if is_executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for dir in EXTRA_INSTALL_DIRS {
        let candidate = if dir.starts_with('/') {
            PathBuf::from(dir).join("claude")
        } else {
            PathBuf::from(&home).join(dir).join("claude")
        };
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(DriverError::Internal(
        "claude CLI not found. Install Claude Code, or pick another provider".into(),
    ))
}

/// Keep at most `STDERR_TAIL_CAP` bytes, cutting at a character boundary so
/// the tail is never a broken sequence in the error register.
fn tail_of(buf: &[u8]) -> String {
    let start = buf.len().saturating_sub(STDERR_TAIL_CAP);
    let mut start = start;
    // step forward off a continuation byte (0b10xxxxxx)
    while start < buf.len() && buf[start] & 0b1100_0000 == 0b1000_0000 {
        start += 1;
    }
    String::from_utf8_lossy(&buf[start..]).trim_end().to_string()
}

/// Signal a pid, ignoring "no such process": the child exiting a microsecond
/// before ⌘. lands is the normal case, not a failure.
fn signal(pid: u32, sig: i32) {
    // SAFETY: kill(2) with a pid this process spawned and a constant signal.
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

/// Spawn `claude` with `args`, write `stdin` to its stdin, relay each stdout
/// line over `on_line`, and resolve when the child exits.
/// What the `claude` child may see of the app's environment. `USER` is
/// load-bearing, not cosmetic: the CLI keys its Keychain credentials on the
/// username, and with only PATH + HOME it answers "Not logged in · Please run
/// /login" (measured 2026-09-05 with `env -i`). `CLAUDE_CONFIG_DIR` rides
/// along so a user's own override still points the child at the same login.
const ENV_PASSTHROUGH: [&str; 7] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "CLAUDE_CONFIG_DIR",
];

fn child_env() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ENV_PASSTHROUGH
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    if !out.iter().any(|(k, _)| k == "PATH") {
        out.push(("PATH".into(), "/usr/bin:/bin".into()));
    }
    // launchd can start the app without USER; the home directory's last
    // segment is the login name on every macOS install we ship to
    if !out.iter().any(|(k, _)| k == "USER") {
        let home = out.iter().find(|(k, _)| k == "HOME").map(|(_, v)| v.clone());
        if let Some(user) = home
            .as_deref()
            .and_then(|h| std::path::Path::new(h).file_name())
            .and_then(|s| s.to_str())
        {
            out.push(("USER".into(), user.to_string()));
        }
    }
    out
}

#[tauri::command]
pub async fn agent_claude_spawn(
    run_id: String,
    args: Vec<String>,
    stdin: String,
    on_line: Channel<String>,
) -> Result<ClaudeExit> {
    let started = Instant::now();
    let binary = resolve_claude()?;

    // The child gets an allowlist, never the app's whole environment (Tauri
    // vars, whatever launchd or a dev shell exported, any API key a shell had
    // lying around): §8.4 promises the trace shows everything that went in.
    let mut command = tokio::process::Command::new(&binary);
    command
        .args(&args)
        .env_clear()
        .envs(child_env())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| {
        DriverError::Internal(format!(
            "couldn't start the claude CLI at {}. {e}",
            binary.display()
        ))
    })?;

    let reaped = CancellationToken::new();
    let pid = child.id().unwrap_or_default();
    running()
        .lock()
        .map_err(|_| DriverError::Internal("run registry poisoned".into()))?
        .insert(
            run_id.clone(),
            RunHandle {
                pid,
                reaped: reaped.clone(),
            },
        );
    let _guard = RunGuard {
        run_id: run_id.clone(),
        reaped,
    };

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| DriverError::Internal("claude CLI stdin was not piped".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DriverError::Internal("claude CLI stdout was not piped".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| DriverError::Internal("claude CLI stderr was not piped".into()))?;

    let write_stdin = async move {
        let _ = child_stdin.write_all(stdin.as_bytes()).await;
        // the CLI waits on EOF before it starts: dropping the handle is the
        // whole protocol, so shut down explicitly rather than by scope
        let _ = child_stdin.shutdown().await;
    };

    let relay_stdout = async {
        let mut lines = BufReader::new(stdout).lines();
        // the UI dropping the channel, or a read error, ends the relay
        while let Ok(Some(line)) = lines.next_line().await {
            if on_line.send(line).is_err() {
                break;
            }
        }
    };

    let drain_stderr = async {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    // bound the buffer: only the tail is ever reported
                    if buf.len() > STDERR_TAIL_CAP * 2 {
                        let cut = buf.len() - STDERR_TAIL_CAP;
                        buf.drain(..cut);
                    }
                }
            }
        }
        buf
    };

    let (_, _, stderr_buf) = tokio::join!(write_stdin, relay_stdout, drain_stderr);
    let status = child
        .wait()
        .await
        .map_err(|e| DriverError::Internal(format!("the claude CLI could not be waited on. {e}")))?;

    Ok(ClaudeExit {
        run_id,
        code: status.code(),
        stderr_tail: tail_of(&stderr_buf),
        ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Kill a running child. Unknown ids are a no-op: the run may have finished
/// between the user's ⌘. and this call.
#[tauri::command]
pub async fn agent_claude_kill(run_id: String) -> Result<()> {
    let handle = running()
        .lock()
        .map_err(|_| DriverError::Internal("run registry poisoned".into()))?
        .get(&run_id)
        .cloned();
    let Some(handle) = handle else {
        return Ok(());
    };
    signal(handle.pid, libc::SIGTERM);
    // Escalate only while the run is still ours: `reaped` fires when the
    // child is waited on, which is the moment its pid becomes reusable.
    tokio::spawn(async move {
        tokio::select! {
            _ = handle.reaped.cancelled() => {}
            _ = tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)) => {
                signal(handle.pid, libc::SIGKILL);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_carries_the_login_and_nothing_else() {
        // process-global, so one test owns it: a stray key in the app's
        // environment must never reach the child
        std::env::set_var("ANTHROPIC_API_KEY", "sk-test-must-not-leak");
        std::env::set_var("QWRY_TEST_SENTINEL", "1");
        let env = child_env();
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"HOME"));
        assert!(keys.contains(&"USER"), "USER is what the CLI's keychain lookup needs");
        assert!(!keys.contains(&"ANTHROPIC_API_KEY"));
        assert!(!keys.contains(&"QWRY_TEST_SENTINEL"));
        for k in &keys {
            assert!(ENV_PASSTHROUGH.contains(k), "unexpected passthrough {k}");
        }
        std::env::remove_var("ANTHROPIC_API_KEY");
        std::env::remove_var("QWRY_TEST_SENTINEL");
    }

    #[test]
    fn the_stderr_tail_is_capped_and_never_cuts_a_character() {
        let long = "é".repeat(STDERR_TAIL_CAP); // 2 bytes each, so twice the cap
        let tail = tail_of(long.as_bytes());
        assert!(tail.len() <= STDERR_TAIL_CAP);
        assert!(!tail.contains('\u{FFFD}'), "cut mid-character");
        assert!(long.ends_with(&tail));
    }

    #[test]
    fn a_short_stderr_survives_whole() {
        assert_eq!(tail_of(b"boom\n"), "boom");
        assert_eq!(tail_of(b""), "");
    }

    /// The resolver must not claim a directory or a non-executable file is the
    /// CLI: "claude CLI not found" is a better error than exec failing later.
    #[test]
    fn only_an_executable_file_counts_as_the_cli() {
        assert!(!is_executable(Path::new("/")));
        assert!(!is_executable(Path::new("/etc/hosts")));
        assert!(is_executable(Path::new("/bin/sh")));
    }

    #[tokio::test]
    async fn killing_an_unknown_run_is_not_an_error() {
        agent_claude_kill("never-spawned".into()).await.expect("no-op");
    }
}
