//! Provider HTTP relay (AGENT-SPEC §7, §8.3; DECISIONS 2026-09-05).
//!
//! Only Rust talks to the network, exactly as only Rust talks to PostgreSQL.
//! TypeScript hands over a provider id, a URL, a method, headers and a body;
//! this module looks the key up in the Keychain (`agent:<provider>`, via
//! `secrets.rs`) and injects the auth header itself, so no key ever reaches
//! TypeScript and Tauri's http scope never has to allowlist a user-supplied
//! host or port.
//!
//! Auth header by provider (W0):
//! - `anthropic`: `x-api-key: <key>` plus `anthropic-version` when the adapter
//!   did not send its own
//! - presets whose auth is `none` (llama-server, vllm, ollama, lmstudio):
//!   nothing is injected
//! - everything else: `Authorization: Bearer <key>`
//!
//! Timeouts: 10s to connect, 60s of idle read, no total cap (a long analysis
//! stream is not a hang). Unreachable local presets get an error carrying a
//! "start the server" hint rather than a bare connection-refused.
//!
//! Cancellation is by caller-minted `request_id`: TypeScript generates the id,
//! passes it in, and can `agent_http_abort` it at any moment, including before
//! the first chunk arrives. A server-minted id would leave that window open.
//!
//! A non-2xx is DATA, not a Rust error: the status arrives on `Start` before
//! any body so the adapter can reject it without parsing an SSE frame, the
//! provider's own error text follows as an `Error` chunk (capped at
//! `ERROR_BODY_CAP`), and the command still resolves `Ok`. `Platform.httpStream`
//! is what turns those into `HttpStatusError` / `HttpUnreachableError`, which
//! it cannot do if the command rejects first.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use crate::driver::{DriverError, Result};

/// header sent alongside `x-api-key` on the Anthropic native adapter
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// connect timeout for every provider request
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
/// idle read timeout: no bytes for this long ends the stream as `unreachable`
pub const IDLE_READ_TIMEOUT_MS: u64 = 60_000;
/// bytes of a non-2xx response body carried into the error message; a provider
/// that answers an error with a megabyte of HTML must not become a Tauri
/// payload of the same size
pub const ERROR_BODY_CAP: usize = 8 * 1024;

/// Why a provider call failed, in the vocabulary the UI speaks (mirrors the
/// `error.kind` of the provider Event union, AGENT-SPEC §7).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpErrorKind {
    Auth,
    Rate,
    Unreachable,
    Provider,
    Cancelled,
}

/// One relayed piece of a provider response. `Start` arrives before any body
/// so the caller can reject a non-2xx before parsing a single SSE frame;
/// `Body` carries raw UTF-8 response bytes (SSE framing is the adapter's job,
/// not this relay's).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HttpChunk {
    Start {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Body {
        text: String,
    },
    Error {
        kind: HttpErrorKind,
        message: String,
        retry_after_ms: Option<u64>,
    },
}

/// Returned when the relay finishes normally (any status, including non-2xx:
/// the status is data, not an error, and the caller decides).
#[derive(Debug, Clone, Serialize)]
pub struct HttpDone {
    pub request_id: String,
    pub status: u16,
    pub ms: f64,
    pub bytes: u64,
}

/// Which auth header form a provider takes. Local runtimes take none, the
/// Anthropic native adapter takes its own pair, everything else is bearer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthForm {
    Bearer,
    Anthropic,
    None,
}

/// The preset→header rule of the W0 provider report, as a table and nothing
/// else: a provider whose auth is `none` must never be sent a header, because
/// a bare `Authorization` on a local llama-server is a 400, not a no-op.
fn auth_form(provider: &str) -> AuthForm {
    match provider {
        "anthropic" => AuthForm::Anthropic,
        // presets whose auth is `none` (W0 §1) plus claude-code, which pays
        // through the CLI's own subscription and has no key at all
        "llama-server" | "vllm" | "ollama" | "lmstudio" | "claude-code" => AuthForm::None,
        _ => AuthForm::Bearer,
    }
}

/// In-flight relays by caller-minted `request_id`. Module-level rather than in
/// `AppState` so an abort works from any command handler without threading the
/// state through the adapter layer.
fn inflight() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static MAP: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deregisters a `request_id` on every exit path, including an early `?`.
struct InflightGuard(String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = inflight().lock() {
            map.remove(&self.0);
        }
    }
}

/// One client for the whole app: connection pooling across turns is most of
/// the "first token under 2s" budget (§10) on hosted providers. No total
/// timeout, because a long analysis stream is not a hang.
fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_millis(CONNECT_TIMEOUT_MS))
                .read_timeout(Duration::from_millis(IDLE_READ_TIMEOUT_MS))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| DriverError::Internal(format!("couldn't start the http client. {e}")))
}

/// Incremental UTF-8 decoder for a byte stream. A provider's SSE frames are
/// split at arbitrary byte offsets, so a multi-byte character routinely
/// straddles two chunks; decoding each chunk on its own would turn one `é`
/// into two replacement characters in the middle of the model's answer.
#[derive(Debug, Default)]
struct Utf8Stream {
    /// bytes of an incomplete trailing sequence, at most 3
    carry: Vec<u8>,
}

impl Utf8Stream {
    /// Decode everything now decodable; hold back an incomplete tail.
    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(s) => {
                    out.push_str(s);
                    self.carry.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.carry[..valid]).unwrap_or(""));
                    match e.error_len() {
                        // genuinely invalid: emit U+FFFD and step over it
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.carry.drain(..valid + bad);
                        }
                        // truncated tail: keep it for the next chunk
                        None => {
                            self.carry.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }

    /// Flush a tail the stream ended on: an incomplete sequence at EOF is
    /// corrupt, not pending, and must not vanish silently.
    fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        let out = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        out
    }
}

fn error_kind_for_status(status: u16) -> HttpErrorKind {
    match status {
        401 | 403 => HttpErrorKind::Auth,
        429 => HttpErrorKind::Rate,
        _ => HttpErrorKind::Provider,
    }
}

/// `Retry-After` in either of its legal forms is worth reading; a date form is
/// ignored rather than guessed at, since a wrong backoff is worse than none.
fn retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get("retry-after")?.to_str().ok()?;
    raw.trim().parse::<f64>().ok().map(|s| (s * 1000.0) as u64)
}

/// The error a non-2xx becomes. The body is the provider's own words, capped;
/// the key is not in it, and is never interpolated into any message here.
fn status_error(status: u16, body: &str, retry_after_ms: Option<u64>) -> HttpChunk {
    let body = body.trim();
    let message = if body.is_empty() {
        format!("provider returned HTTP {status}")
    } else {
        format!("HTTP {status}: {body}")
    };
    HttpChunk::Error {
        kind: error_kind_for_status(status),
        message,
        retry_after_ms,
    }
}

/// A local preset that is simply not running is the single most common
/// failure of the local path, and "connection refused" does not tell a user
/// what to do about it.
fn unreachable_message(url: &str, detail: &str) -> String {
    let local = reqwest::Url::parse(url).ok().is_some_and(|u| {
        matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("::1"))
    });
    if local {
        let where_ = reqwest::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            }))
            .unwrap_or_else(|| "the local server".into());
        format!("couldn't reach {where_}. Start the model server and try again")
    } else {
        format!("couldn't reach the provider. {detail}")
    }
}

/// Build the outbound header map: the adapter's own headers first, then ours.
/// Any auth header the caller passed is dropped rather than merged, so a
/// TypeScript bug can never smuggle a header past the Keychain path.
/// `anthropic-version` is not an auth header and is left alone: the adapter
/// knows which wire shape it was written against, so its value wins and ours
/// only fills in when it sent none.
fn outbound_headers(
    provider: &str,
    caller: &[(String, String)],
) -> Result<(HeaderMap, Option<HttpChunk>)> {
    let mut map = HeaderMap::new();
    for (k, v) in caller {
        let lower = k.to_ascii_lowercase();
        if lower == "authorization" || lower == "x-api-key" {
            continue;
        }
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| DriverError::Internal(format!("invalid header name {k}")))?;
        let value = HeaderValue::from_str(v)
            .map_err(|_| DriverError::Internal(format!("invalid value for header {k}")))?;
        map.insert(name, value);
    }

    let form = auth_form(provider);
    if form == AuthForm::None {
        return Ok((map, None));
    }
    let Some(key) = crate::secrets::get_agent_key(provider)? else {
        return Ok((
            map,
            Some(HttpChunk::Error {
                kind: HttpErrorKind::Auth,
                message: format!("no API key saved for {provider}. Add one in settings"),
                retry_after_ms: None,
            }),
        ));
    };
    // from_str on a secret: the error carries the header name, never the value
    let mut secret = match form {
        AuthForm::Anthropic => HeaderValue::from_str(&key),
        _ => HeaderValue::from_str(&format!("Bearer {key}")),
    }
    .map_err(|_| DriverError::Internal("the saved API key is not a valid header value".into()))?;
    secret.set_sensitive(true);
    match form {
        AuthForm::Anthropic => {
            map.insert("x-api-key", secret);
            map.entry("anthropic-version")
                .or_insert(HeaderValue::from_static(ANTHROPIC_VERSION));
        }
        _ => {
            map.insert(reqwest::header::AUTHORIZATION, secret);
        }
    }
    Ok((map, None))
}

fn send(on_chunk: &Channel<HttpChunk>, chunk: HttpChunk) -> Result<()> {
    on_chunk
        .send(chunk)
        .map_err(|e| DriverError::Internal(format!("relay channel closed. {e}")))
}

/// Stream one provider request. `headers` are the adapter's own headers
/// (content-type, preset `extraHeaders`); the auth header is added here and
/// must never be passed in. `body` is the serialized request, `None` for GET.
#[tauri::command]
pub async fn agent_http_stream(
    request_id: String,
    provider: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_chunk: Channel<HttpChunk>,
) -> Result<HttpDone> {
    let started = Instant::now();
    let done = |status: u16, bytes: u64| HttpDone {
        request_id: request_id.clone(),
        status,
        ms: started.elapsed().as_secs_f64() * 1000.0,
        bytes,
    };

    let token = CancellationToken::new();
    inflight()
        .lock()
        .map_err(|_| DriverError::Internal("relay registry poisoned".into()))?
        .insert(request_id.clone(), token.clone());
    let _guard = InflightGuard(request_id.clone());

    let (headers, missing_key) = outbound_headers(&provider, &headers)?;
    if let Some(err) = missing_key {
        send(&on_chunk, err)?;
        return Ok(done(0, 0));
    }

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| DriverError::Internal(format!("invalid HTTP method {method}")))?;
    let mut req = client()?.request(method, &url).headers(headers);
    if let Some(body) = body {
        req = req.body(body);
    }

    let resp = tokio::select! {
        biased;
        _ = token.cancelled() => {
            send(&on_chunk, HttpChunk::Error {
                kind: HttpErrorKind::Cancelled,
                message: "cancelled".into(),
                retry_after_ms: None,
            })?;
            return Ok(done(0, 0));
        }
        r = req.send() => r,
    };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            send(
                &on_chunk,
                HttpChunk::Error {
                    kind: HttpErrorKind::Unreachable,
                    message: unreachable_message(&url, &e.to_string()),
                    retry_after_ms: None,
                },
            )?;
            return Ok(done(0, 0));
        }
    };

    let status = resp.status().as_u16();
    let retry_ms = retry_after_ms(resp.headers());
    let header_pairs: Vec<(String, String)> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();
    send(
        &on_chunk,
        HttpChunk::Start {
            status,
            headers: header_pairs,
        },
    )?;

    let mut stream = resp.bytes_stream();

    // non-2xx: the body is the provider's error text, not a stream to relay
    if !(200..300).contains(&status) {
        let mut buf: Vec<u8> = Vec::new();
        while buf.len() < ERROR_BODY_CAP {
            let next = tokio::select! {
                biased;
                _ = token.cancelled() => {
                    // an abort mid-drain is the user's cancel, not the
                    // provider's error: reporting the partial body as
                    // Auth/Rate/Provider would record a failure that never
                    // happened
                    send(&on_chunk, HttpChunk::Error {
                        kind: HttpErrorKind::Cancelled,
                        message: "cancelled".into(),
                        retry_after_ms: None,
                    })?;
                    return Ok(done(status, buf.len() as u64));
                }
                n = stream.next() => n,
            };
            match next {
                Some(Ok(bytes)) => buf.extend_from_slice(&bytes),
                Some(Err(_)) | None => break,
            }
        }
        buf.truncate(ERROR_BODY_CAP);
        let text = String::from_utf8_lossy(&buf);
        send(&on_chunk, status_error(status, &text, retry_ms))?;
        return Ok(done(status, buf.len() as u64));
    }

    let mut decoder = Utf8Stream::default();
    let mut bytes: u64 = 0;
    loop {
        let next = tokio::select! {
            biased;
            _ = token.cancelled() => {
                send(&on_chunk, HttpChunk::Error {
                    kind: HttpErrorKind::Cancelled,
                    message: "cancelled".into(),
                    retry_after_ms: None,
                })?;
                return Ok(done(status, bytes));
            }
            n = stream.next() => n,
        };
        match next {
            Some(Ok(chunk)) => {
                bytes += chunk.len() as u64;
                let text = decoder.push(&chunk);
                if !text.is_empty() {
                    send(&on_chunk, HttpChunk::Body { text })?;
                }
            }
            Some(Err(e)) => {
                send(
                    &on_chunk,
                    HttpChunk::Error {
                        kind: HttpErrorKind::Unreachable,
                        message: unreachable_message(&url, &e.to_string()),
                        retry_after_ms: None,
                    },
                )?;
                return Ok(done(status, bytes));
            }
            None => break,
        }
    }
    let tail = decoder.flush();
    if !tail.is_empty() {
        send(&on_chunk, HttpChunk::Body { text: tail })?;
    }
    Ok(done(status, bytes))
}

/// Abort an in-flight relay. Unknown ids are a no-op: the request may have
/// finished between the user's ⌘. and this call, and that is not an error.
#[tauri::command]
pub async fn agent_http_abort(request_id: String) -> Result<()> {
    let token = inflight()
        .lock()
        .map_err(|_| DriverError::Internal("relay registry poisoned".into()))?
        .remove(&request_id);
    if let Some(token) = token {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_auth_forms_follow_the_w0_table() {
        assert_eq!(auth_form("anthropic"), AuthForm::Anthropic);
        for local in ["llama-server", "vllm", "ollama", "lmstudio", "claude-code"] {
            assert_eq!(auth_form(local), AuthForm::None, "{local} takes no key");
        }
        for bearer in ["openai", "openrouter", "groq", "mistral", "gemini", "xai"] {
            assert_eq!(auth_form(bearer), AuthForm::Bearer, "{bearer} is bearer");
        }
    }

    /// A provider response split mid-character must not corrupt the text: the
    /// relay is byte-transparent, and an SSE frame boundary is not a character
    /// boundary.
    #[test]
    fn a_multibyte_character_split_across_chunks_survives() {
        let src = "data: {\"text\":\"héllo → 世界\"}\n\n";
        let bytes = src.as_bytes();
        for split in 1..bytes.len() {
            let mut d = Utf8Stream::default();
            let mut out = d.push(&bytes[..split]);
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.flush());
            assert_eq!(out, src, "split at {split}");
        }
    }

    #[test]
    fn a_character_split_three_ways_survives() {
        // U+1F600 is four bytes: feed it one byte per chunk
        let src = "a😀b";
        let mut d = Utf8Stream::default();
        let mut out = String::new();
        for b in src.as_bytes() {
            out.push_str(&d.push(&[*b]));
        }
        out.push_str(&d.flush());
        assert_eq!(out, src);
    }

    #[test]
    fn invalid_bytes_become_one_replacement_char_and_the_stream_continues() {
        let mut d = Utf8Stream::default();
        let out = d.push(&[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
    }

    /// §8.3 is literal: the key is never read into a message, a log, or a
    /// serialized payload. A 401 is the one path where a careless
    /// implementation echoes the request back, so it is the one to pin.
    #[test]
    fn a_401_error_never_carries_the_key() {
        const KEY: &str = "sk-ant-secret-value-do-not-leak";
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let chunk = status_error(401, body, None);
        let rendered = serde_json::to_string(&chunk).expect("serialize");
        assert!(!rendered.contains(KEY), "{rendered}");
        assert!(rendered.contains("invalid x-api-key"));
        assert!(rendered.contains("\"kind\":\"auth\""));

        // the same for the header value itself: HeaderValue redacts a
        // sensitive value in Debug, which is what a log line would print
        let mut hv = HeaderValue::from_str(KEY).expect("header value");
        hv.set_sensitive(true);
        assert!(!format!("{hv:?}").contains(KEY));

        // and for the DriverError a caller would surface
        let err = DriverError::Internal("the saved API key is not a valid header value".into());
        assert!(!err.to_string().contains(KEY));
    }

    #[test]
    fn statuses_map_to_the_ui_error_vocabulary() {
        assert!(matches!(error_kind_for_status(401), HttpErrorKind::Auth));
        assert!(matches!(error_kind_for_status(403), HttpErrorKind::Auth));
        assert!(matches!(error_kind_for_status(429), HttpErrorKind::Rate));
        assert!(matches!(error_kind_for_status(500), HttpErrorKind::Provider));
        assert!(matches!(error_kind_for_status(400), HttpErrorKind::Provider));
    }

    #[test]
    fn an_unreachable_local_preset_says_how_to_fix_it() {
        let m = unreachable_message("http://127.0.0.1:8089/v1/chat/completions", "connection refused");
        assert!(m.contains("127.0.0.1:8089"), "{m}");
        assert!(m.contains("Start the model server"), "{m}");
        let hosted = unreachable_message("https://api.openai.com/v1/chat/completions", "dns error");
        assert!(!hosted.contains("Start the model server"), "{hosted}");
    }

    #[test]
    fn a_caller_supplied_auth_header_is_dropped() {
        let caller = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("authorization".to_string(), "Bearer smuggled".to_string()),
            ("X-Api-Key".to_string(), "smuggled".to_string()),
        ];
        // llama-server takes no key, so nothing is injected either: whatever
        // survives is exactly what the adapter is allowed to set
        let (map, missing) = outbound_headers("llama-server", &caller).expect("headers");
        assert!(missing.is_none());
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("content-type"));
    }

    #[tokio::test]
    async fn aborting_an_unknown_request_is_not_an_error() {
        agent_http_abort("never-started".into()).await.expect("no-op");
    }
}
