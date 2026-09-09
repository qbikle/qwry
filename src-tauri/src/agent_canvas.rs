//! The canvas bridge: the `claude -p` path's canvas tools, parked in Rust and
//! answered in TypeScript (canvas-agent-spec §1.7, §2.2).
//!
//! `agent_mcp.rs` mirrors the five tools' RESULT TEXT in Rust, because the
//! child process must read the same app the OpenAI adapter does. The canvas
//! family is deliberately NOT mirrored: block ids, the block shape, the row
//! caps, whether a chart exists for these rows and the document's own rules
//! live in `src/agent/canvas.tauri.ts`, and a second copy here would double
//! that file's largest debt and drift on the first cap change. So the MCP
//! server carries the three tool names and none of their meaning: a call is
//! emitted as `canvas-tool-call`, parked on a oneshot, and completed by the
//! app through `agent_canvas_result`. Rust holds zero canvas semantics.
//!
//! The park is safe because the TypeScript side is alive by construction
//! whenever a canvas call can arrive: the child was spawned by the running
//! loop, and its bearer token is revoked in the same `finally` that ends the
//! exchange (`providers/claudecode.ts`). A revoked token drops its parked
//! calls (`drop_parked`), and a call nobody answers ends at the timeout with
//! text the model can act on rather than a hung tool call.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;

use crate::agent_mcp::ToolText;
use crate::driver::Result;

/// How long the MCP side waits for the app to apply one canvas tool call.
/// Mirrored by `CANVAS_BRIDGE_TIMEOUT_MS` in `src/agent/tools.ts`: generous
/// next to a store write, and short enough that a torn-down window does not
/// hold the child's turn.
pub const CANVAS_BRIDGE_TIMEOUT_MS: u64 = 20_000;

/// The event the app listens for. One event, three tools: the name rides in
/// the payload, so a new canvas tool costs no new channel.
pub const CANVAS_TOOL_CALL_EVENT: &str = "canvas-tool-call";

/// The canvas family, in the order `tools.schema.json` lists it. The names
/// are here rather than in the schema file because the bridge must route them
/// whatever the file advertises, and because a name is a wire fact: the
/// TypeScript side answers these three and nothing else (§1.1).
pub const CANVAS_TOOL_NAMES: [&str; 3] = ["canvas_write", "canvas_replace", "canvas_read"];

/// The timeout's text, in the `ERROR: <first line>` shape every tool failure
/// takes (AGENT-SPEC §5). It names the way out: the findings still exist, and
/// the reply is a place to put them.
const TIMED_OUT: &str = "ERROR: the canvas did not answer. Say your findings here instead";

/// A park cleared without an answer: the thread's token was revoked while the
/// call was out, so the canvas this call aimed at is gone. Not the timeout's
/// text, because the two are different facts and the trace shows which one
/// happened.
const CLOSED: &str = "ERROR: the canvas is closed. Say your findings here instead";

/// One canvas tool call, as the app receives it. `token` is the caller's MCP
/// bearer token and `session_id` its database session: the app registers its
/// canvas tools under one of them, and this payload is the only place it can
/// learn either (`src/agent/canvas.tauri.ts` keys on the session). `args_json`
/// is the model's arguments as it wrote them, never parsed on this side: the
/// TypeScript tool owns every cap, every refusal text and the reply to a body
/// that is not JSON at all.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasToolCall {
    pub call_id: String,
    pub token: String,
    pub session_id: String,
    pub name: String,
    pub args_json: String,
}

/// A call waiting for the app. The token rides along so a revoked thread can
/// drop exactly its own calls without walking the app's state.
struct Parked {
    token: String,
    tx: tokio::sync::oneshot::Sender<ToolText>,
}

/// Process-wide, like the MCP token registry beside it: a call arrives on a
/// connection task and is answered on a command task, so the two can only
/// meet through something neither owns.
fn parked() -> &'static Mutex<HashMap<String, Parked>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Parked>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask the app to apply one canvas tool call, and wait for its answer.
pub async fn call(
    app: &tauri::AppHandle,
    token: &str,
    session_id: &str,
    name: String,
    args_json: String,
) -> ToolText {
    let payload = CanvasToolCall {
        call_id: uuid::Uuid::new_v4().to_string(),
        token: token.to_string(),
        session_id: session_id.to_string(),
        name,
        args_json,
    };
    let app = app.clone();
    park(
        move |c| {
            let _ = app.emit(CANVAS_TOOL_CALL_EVENT, c);
        },
        payload,
        Duration::from_millis(CANVAS_BRIDGE_TIMEOUT_MS),
    )
    .await
}

/// The bridge itself, with the emit as an argument: park, hand the call over,
/// wait. A unit test answers the call the way the app does, which is what
/// lets the round trip and the timeout be tested without an `AppHandle`.
async fn park(
    emit: impl FnOnce(&CanvasToolCall),
    payload: CanvasToolCall,
    wait: Duration,
) -> ToolText {
    let call_id = payload.call_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // the guard lives in its own scope: a std lock held across an await makes
    // the whole future non-Send, and this one is boxed into a trait object
    {
        let Ok(mut map) = parked().lock() else {
            return Err(CLOSED.to_string());
        };
        map.insert(
            call_id.clone(),
            Parked {
                token: payload.token.clone(),
                tx,
            },
        );
    }
    // parked BEFORE the emit: the app can answer inside the listener without
    // racing the entry it answers into
    emit(&payload);
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(text)) => text,
        // the sender was dropped, which only `drop_parked` does
        Ok(Err(_)) => Err(CLOSED.to_string()),
        Err(_) => {
            if let Ok(mut map) = parked().lock() {
                map.remove(&call_id);
            }
            Err(TIMED_OUT.to_string())
        }
    }
}

/// Complete one parked call. `false` means nothing was waiting: the call
/// timed out or its thread closed while the app was applying it, and a late
/// answer has nowhere to go. The blocks it wrote stand, which is the same
/// state a person reaches by typing a note the model never read.
fn complete(call_id: &str, text: String, is_error: bool) -> bool {
    let Ok(mut map) = parked().lock() else {
        return false;
    };
    let Some(entry) = map.remove(call_id) else {
        return false;
    };
    drop(map);
    let answer = if is_error { Err(text) } else { Ok(text) };
    entry.tx.send(answer).is_ok()
}

/// Drop every call parked for one bearer token, answering each with `CLOSED`.
/// Called when the token is revoked: a stopped server must not leave a child
/// waiting out its whole timeout for an app that will never answer.
pub fn drop_parked(token: &str) -> usize {
    let Ok(mut map) = parked().lock() else {
        return 0;
    };
    let gone: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.token == token)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &gone {
        map.remove(id);
    }
    gone.len()
}

/// The app's answer to one `canvas-tool-call`: the text the model sees, in
/// the shape the tool built it. `is_error` flags it the way a failed tool
/// call is flagged, so the repair loop reads it as a failure and not as a
/// result (AGENT-SPEC §5).
#[tauri::command]
pub async fn agent_canvas_result(call_id: String, text: String, is_error: bool) -> Result<()> {
    complete(&call_id, text, is_error);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(token: &str, name: &str) -> CanvasToolCall {
        CanvasToolCall {
            call_id: uuid::Uuid::new_v4().to_string(),
            token: token.to_string(),
            session_id: "session-canvas".to_string(),
            name: name.to_string(),
            args_json: r#"{"blocks":[{"kind":"note","text":"hi"}]}"#.to_string(),
        }
    }

    /// The payload is the whole contract with `src/ipc/types.ts` and with the
    /// listener in `src/agent/canvas.tauri.ts`: snake_case field names, both
    /// identities the app can key its tools on, and the model's arguments as
    /// the text it wrote.
    #[test]
    fn the_event_payload_names_the_call_the_token_and_the_session() {
        let v = serde_json::to_value(payload("tok", "canvas_write")).expect("serialize");
        let mut keys: Vec<&str> =
            v.as_object().expect("object").keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["args_json", "call_id", "name", "session_id", "token"]);
        assert_eq!(v["name"], "canvas_write");
        assert_eq!(v["token"], "tok");
        assert_eq!(v["session_id"], "session-canvas");
        assert_eq!(v["args_json"], r#"{"blocks":[{"kind":"note","text":"hi"}]}"#);
        assert_eq!(CANVAS_TOOL_CALL_EVENT, "canvas-tool-call");
    }

    #[tokio::test]
    async fn a_parked_call_takes_the_apps_answer() {
        let out = park(
            |c| {
                assert_eq!(c.name, "canvas_write");
                assert!(complete(&c.call_id, "Wrote 2 blocks to \"Sales\".".into(), false));
            },
            payload("tok-round-trip", "canvas_write"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(out, Ok("Wrote 2 blocks to \"Sales\".".to_string()));
    }

    /// A refusal comes back flagged, so `call_tool` marks it `isError` and the
    /// prose-strike breaker counts it as it always did.
    #[tokio::test]
    async fn an_answer_flagged_as_an_error_stays_an_error() {
        let out = park(
            |c| {
                complete(
                    &c.call_id,
                    "ERROR: a note block needs `text`, and it cannot be empty. Deleting a block is the user's own action".into(),
                    true,
                );
            },
            payload("tok-error", "canvas_write"),
            Duration::from_secs(5),
        )
        .await;
        assert!(out.is_err());
        assert!(out.unwrap_err().starts_with("ERROR: a note block needs"));
    }

    /// A call nobody answers ends in text the model can act on, and leaves
    /// nothing parked: a window that went away must not grow this map.
    #[tokio::test]
    async fn a_call_nobody_answers_times_out_and_says_where_to_put_the_findings() {
        let call = payload("tok-timeout", "canvas_read");
        let id = call.call_id.clone();
        let out = park(|_| {}, call, Duration::from_millis(30)).await;
        assert_eq!(out, Err(TIMED_OUT.to_string()));
        assert_eq!(
            out.unwrap_err(),
            "ERROR: the canvas did not answer. Say your findings here instead"
        );
        assert!(!parked().lock().expect("lock").contains_key(&id));
        assert!(!complete(&id, "late".into(), false));
    }

    /// Revoking a token is what ends an exchange, so it must not leave the
    /// child waiting out twenty seconds for an app that is done with it. The
    /// revoke happens where the app would be reading the call, which is the
    /// race worth pinning: parked, handed over, then torn down.
    #[tokio::test]
    async fn a_stopped_server_drops_the_calls_parked_for_its_token() {
        let out = park(
            |c| {
                assert_eq!(c.token, "tok-stopped");
                assert_eq!(drop_parked("tok-stopped"), 1);
            },
            payload("tok-stopped", "canvas_write"),
            // long enough that a timeout, not the drop, would be the failure
            Duration::from_secs(30),
        )
        .await;
        assert_eq!(out, Err(CLOSED.to_string()));
        assert_eq!(
            out.unwrap_err(),
            "ERROR: the canvas is closed. Say your findings here instead"
        );
        assert_eq!(drop_parked("tok-stopped"), 0);
    }

    #[test]
    fn an_answer_to_a_call_nobody_parked_is_dropped() {
        assert!(!complete("no-such-call", "Wrote a block.".into(), false));
    }
}
