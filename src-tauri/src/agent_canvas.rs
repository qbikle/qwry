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
//!
//! C2b adds the one thing an answer can carry besides text: a drawing's PNG,
//! which `canvas_read({ block_id })` returns beside the block's line. Rust
//! still holds zero canvas semantics. It does not know what a drawing is, it
//! renders nothing, and it reads no strokes: it takes base64 and a media type
//! from the app and decides only whether that can go on the wire, which is a
//! wire fact and therefore this side's (`TOOL_IMAGE_B64_MAX`, `carry`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::agent_mcp::{ToolAnswer, ToolImage, ToolReply};
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

/// The most base64 one tool result may carry. 5 MB of base64 is about 3.7 MB
/// of PNG: half of what the Messages API takes for one image, and far over a
/// drawing rendered at 2x and clamped to a 1568px long edge, which measures in
/// the hundreds of kilobytes. The cap is here rather than in the app because
/// this side is the one that puts the string on the wire, and a door must not
/// be handed something unbounded by the window on the other side of it.
pub const TOOL_IMAGE_B64_MAX: usize = 5_000_000;

/// The media types Claude Code documents an MCP image content block may wear
/// (agent-sdk custom tools, verified 2026-09-11). A type off this list never
/// reaches the child: an image it cannot decode is a turn spent learning that.
pub const TOOL_IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// The image half of the app's answer, as the webview sends it: raw base64 and
/// its media type, the two apart, never a `data:` URI. The app builds the PNG
/// (the canvas owns the strokes and the renderer); this side decides only
/// whether it can travel.
#[derive(Debug, Clone, Deserialize)]
pub struct ImagePayload {
    pub b64: String,
    pub mime: String,
}

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
    tx: tokio::sync::oneshot::Sender<ToolAnswer>,
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
) -> ToolAnswer {
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
) -> ToolAnswer {
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

/// `7.2 MB`, rounded UP. The one size this file prints is a size being
/// turned away, and a cap message must never understate what it refused.
fn mb(bytes: usize) -> String {
    format!("{:.1} MB", (bytes as f64 / 100_000.0).ceil() / 10.0)
}

/// What one answer's image becomes on the wire, and what the model is told
/// when it becomes nothing. Never a refusal and never a silence: the text the
/// tool built still stands whole, and a picture that could not travel is one
/// LINE inside it, so the model reads why it is looking at an outline instead
/// of a drawing (LESSONS 5, LESSONS 9).
fn carry(image: Option<ImagePayload>) -> (Option<ToolImage>, Option<String>) {
    let Some(image) = image else {
        return (None, None);
    };
    if !TOOL_IMAGE_MIMES.contains(&image.mime.as_str()) {
        // the type is printed back, clipped: it arrives from the webview and
        // an unbounded one would be a whole turn of the model's context
        let said: String = image.mime.chars().take(40).collect();
        return (
            None,
            Some(format!(
                "the image is {said}, which an image block cannot carry, so this reply carries the text alone"
            )),
        );
    }
    if image.b64.len() > TOOL_IMAGE_B64_MAX {
        return (
            None,
            Some(format!(
                "the image came to {}, over the {} cap, so this reply carries the text alone",
                mb(image.b64.len()),
                mb(TOOL_IMAGE_B64_MAX)
            )),
        );
    }
    (
        Some(ToolImage {
            b64: image.b64,
            mime: image.mime,
        }),
        None,
    )
}

/// Complete one parked call. `false` means nothing was waiting: the call
/// timed out or its thread closed while the app was applying it, and a late
/// answer has nowhere to go. The blocks it wrote stand, which is the same
/// state a person reaches by typing a note the model never read.
///
/// An answer flagged as an error carries no image: a failure is text the
/// repair loop reads, and there is nothing to picture in one.
fn complete(call_id: &str, text: String, is_error: bool, image: Option<ImagePayload>) -> bool {
    let Ok(mut map) = parked().lock() else {
        return false;
    };
    let Some(entry) = map.remove(call_id) else {
        return false;
    };
    drop(map);
    let answer = if is_error {
        Err(text)
    } else {
        let (image, said) = carry(image);
        let text = match said {
            Some(line) => format!("{text}\n{line}"),
            None => text,
        };
        Ok(ToolReply { text, image })
    };
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
/// result (AGENT-SPEC §5). `image` is C2b's one addition: a drawing's PNG,
/// which `canvas_read({ block_id })` answers with beside the block's line,
/// and which nothing else on the canvas produces.
#[tauri::command]
pub async fn agent_canvas_result(
    call_id: String,
    text: String,
    is_error: bool,
    image: Option<ImagePayload>,
) -> Result<()> {
    complete(&call_id, text, is_error, image);
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
                assert!(complete(&c.call_id, "Wrote 2 blocks to \"Sales\".".into(), false, None));
            },
            payload("tok-round-trip", "canvas_write"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(out, Ok(ToolReply::text("Wrote 2 blocks to \"Sales\".")));
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
                    None,
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
        assert!(!complete(&id, "late".into(), false, None));
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
        assert!(!complete("no-such-call", "Wrote a block.".into(), false, None));
    }

    // ---- the image half (C2b) ---------------------------------------------

    fn png(b64: &str) -> ImagePayload {
        ImagePayload {
            b64: b64.to_string(),
            mime: "image/png".to_string(),
        }
    }

    /// `canvas_read({ block_id })` on a drawing: the block's line, and its PNG
    /// beside it. The text is untouched, so the model reads the same outline
    /// it would have read without a picture.
    #[tokio::test]
    async fn a_drawing_comes_back_as_a_line_and_its_png() {
        let out = park(
            |c| {
                assert_eq!(c.name, "canvas_read");
                assert!(complete(
                    &c.call_id,
                    "a3f1  drawing  Sketch · at 0,0 3x3".into(),
                    false,
                    Some(png("iVBORw0KGgo=")),
                ));
            },
            payload("tok-image", "canvas_read"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            out,
            Ok(ToolReply {
                text: "a3f1  drawing  Sketch · at 0,0 3x3".to_string(),
                image: Some(ToolImage {
                    b64: "iVBORw0KGgo=".to_string(),
                    mime: "image/png".to_string(),
                }),
            })
        );
    }

    /// The cap refuses the picture and NOT the answer, and says which of the
    /// two happened. A silent drop would read to the model as a canvas that
    /// holds an empty drawing (LESSONS 9).
    #[test]
    fn an_image_over_the_cap_is_dropped_and_the_reply_says_so() {
        let (image, said) = carry(Some(png(&"A".repeat(TOOL_IMAGE_B64_MAX + 1))));
        assert!(image.is_none());
        assert_eq!(
            said.as_deref(),
            Some("the image came to 5.1 MB, over the 5.0 MB cap, so this reply carries the text alone")
        );
    }

    /// Exactly the cap travels: the boundary belongs to the side that can be
    /// read, not to the side that can only be guessed at.
    #[test]
    fn an_image_exactly_at_the_cap_travels() {
        let (image, said) = carry(Some(png(&"A".repeat(TOOL_IMAGE_B64_MAX))));
        assert!(said.is_none());
        assert_eq!(image.expect("image").b64.len(), TOOL_IMAGE_B64_MAX);
    }

    /// A media type the child cannot decode never reaches it, and the line
    /// names the type rather than saying that something went wrong.
    #[test]
    fn an_image_of_a_type_the_child_cannot_read_is_named_not_sent() {
        let odd = ImagePayload {
            b64: "AAAA".into(),
            mime: "image/tiff".into(),
        };
        let (image, said) = carry(Some(odd));
        assert!(image.is_none());
        assert_eq!(
            said.as_deref(),
            Some(
                "the image is image/tiff, which an image block cannot carry, so this reply carries the text alone"
            )
        );
        for mime in TOOL_IMAGE_MIMES {
            let (ok, none) = carry(Some(ImagePayload {
                b64: "AAAA".into(),
                mime: mime.into(),
            }));
            assert!(ok.is_some() && none.is_none(), "{mime} should travel");
        }
    }

    /// The media type is the webview's string: printed back clipped, so a
    /// runaway one cannot spend the model's context on itself.
    #[test]
    fn a_runaway_media_type_is_clipped_before_it_is_printed() {
        let (image, said) = carry(Some(ImagePayload {
            b64: "AAAA".into(),
            mime: "image/".to_string() + &"z".repeat(4_000),
        }));
        assert!(image.is_none());
        let said = said.expect("a line");
        assert!(said.starts_with("the image is image/zzz"));
        assert!(said.len() < 140, "the line stays a line: {}", said.len());
    }

    /// An error carries no image. A failed call is text the repair loop reads,
    /// and a picture attached to one would be a second reading of a refusal.
    #[tokio::test]
    async fn an_error_answer_drops_the_image() {
        let out = park(
            |c| {
                complete(
                    &c.call_id,
                    "ERROR: no block 'zzzz' on this canvas. Call canvas_read for the block ids".into(),
                    true,
                    Some(png("iVBORw0KGgo=")),
                );
            },
            payload("tok-error-image", "canvas_read"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            out,
            Err("ERROR: no block 'zzzz' on this canvas. Call canvas_read for the block ids".into())
        );
    }

    /// The two halves of the answer, as the app sends them: the webview posts
    /// `image` as an object of two strings, and nothing else.
    #[test]
    fn the_image_payload_is_two_strings_and_optional() {
        let p: ImagePayload =
            serde_json::from_value(serde_json::json!({"b64": "AAAA", "mime": "image/png"}))
                .expect("deserialize");
        assert_eq!(p.b64, "AAAA");
        assert_eq!(p.mime, "image/png");
        let none: Option<ImagePayload> = serde_json::from_value(serde_json::Value::Null).expect("null");
        assert!(none.is_none());
    }
}
