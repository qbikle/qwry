//! Streamable-HTTP MCP server for the `claude -p` provider (AGENT-SPEC §7,
//! §11 q1; DECISIONS 2026-09-05).
//!
//! `claude -p` executes tools itself, so it needs to reach qwry's five tools
//! over the wire. It speaks HTTP through `--mcp-config`, and Rust already owns
//! a tokio runtime: an in-process server is the transport with no extra hop.
//! Built on `rmcp`'s `StreamableHttpService` (a `tower::Service`) bridged onto
//! a bare `hyper` connection with `hyper_util::service::TowerToHyperService`,
//! on a `tokio::net::TcpListener` bound to `127.0.0.1:0`. No axum: its router
//! and extractors buy nothing for one fixed path and one bearer check. The W0
//! spike compiled this shape and served a live `initialize`.
//!
//! ONE server per app instance, started lazily on first Ask use. Threads are
//! separated by BEARER TOKEN, not by port and never by `Mcp-Session-Id`: the
//! CLI (2.1.260) opens with the session-less 2026-07-28 revision and falls
//! back to 2025-11-25, so a session id may not exist at all. Each thread mints
//! a token at creation; the token maps to that thread's dedicated `SessionId`;
//! the map entry dies with the thread, so a child calling back into a torn
//! down thread gets a clean error instead of another thread's session.
//!
//! The server is configured stateless (`legacy_session_mode: false`,
//! `json_response: true`): it never pushes a message of its own, so a plain
//! `application/json` body per POST is legal (MCP 2025-06-18 transports, W0
//! §6) and no session id is ever issued for anything to route on.
//!
//! Security: bind 127.0.0.1 only, validate `Origin` (MCP spec's DNS-rebinding
//! defence), and reject any request whose bearer token is unknown.
//!
//! The tool schemas served here are `src/agent/tools.schema.json`, included at
//! compile time, so the MCP surface and the surface every other provider sees
//! are byte-identical. The RESULT TEXT has to match too, or `claude -p` reads a
//! different app than the OpenAI adapter does: `Meta`, `describe_text`,
//! `run_text`, `peek_text` and `probe_text` below mirror `buildMeta` /
//! `renderDescribe` in `src/agent/context.ts` and `formatRun` in
//! `src/agent/tools.tauri.ts` line for line. Change one, change both.
//!
//! The CANVAS family (`canvas_write`, `canvas_replace`, `canvas_read`) is the
//! one exception, and deliberately: those three are advertised here and
//! implemented nowhere here. `agent_canvas.rs` parks the call and the app
//! applies it in TypeScript, which is the only place the block shape, the row
//! caps, the block ids and the result texts live. Mirroring three more tools
//! would double this file's largest debt (canvas-agent-spec §1.7).
//!
//! Which tools a token serves is fixed when it is minted: `agent_mcp_serve`
//! takes the list the loop handed its provider, so a thread with no canvas
//! target serves the five and a model that has no canvas to write into is
//! never shown a tool that would refuse it (§1.6).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use bytes::Bytes;
use http::header::{AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use http::{HeaderValue, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::service::Service as HyperService;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;

use crate::agent::{ColumnValues, TableValues};
use crate::driver::postgres::edit::TableRef;
use crate::driver::postgres::introspect::{SchemaSnapshot, TableInfo};
use crate::driver::postgres::PgSession;
use crate::driver::{DriverError, Result};
use crate::state::AppState;

/// The tool schemas (AGENT-SPEC §5), shared verbatim with TypeScript:
/// `tools` is the five, `canvasTools` the canvas family. `tools.ts` imports
/// the same file; neither side may paraphrase the other. Included at compile
/// time rather than read from disk because a bundled `.app` has no `src/`
/// beside it, and a second reader would be a second authority.
pub const TOOL_SCHEMAS_JSON: &str = include_str!("../../src/agent/tools.schema.json");

/// MCP server name; `claude -p` exposes the tools as `mcp__qwry__<tool>` and
/// `--allowedTools 'mcp__qwry__*'` must match this exactly.
pub const SERVER_NAME: &str = "qwry";

/// Path the endpoint advertises. The token is the identity, so the path is
/// cosmetic; it matches what every other MCP server publishes.
pub const MCP_PATH: &str = "/mcp";

/// Rows a `run_sql` or `probe` result shows the MODEL (§5). Never lower it to
/// save tokens: the lean variant did and looped to the turn cap re-querying
/// what it could not see.
pub const MODEL_ROW_CAP: usize = 50;

/// `statement_timeout` for a tool-issued query when the caller states none.
/// An MCP call arrives from the child process rather than from the loop, so it
/// cannot read TypeScript's `useSettings` itself: `agent_mcp_serve` takes the
/// setting once, per thread, and this is the §5 default it falls back to.
pub const RUN_SQL_TIMEOUT_MS: u64 = 10_000;

/// Tool calls kept per token for the trace. A thread that somehow ran away
/// must not grow this without bound.
pub const CALL_LOG_CAP: usize = 500;

/// Where a thread's `claude -p` child should point its `--mcp-config`.
/// `token` goes in `headers.Authorization` as `Bearer <token>`; it is
/// delivered on every request of that connection, POST and GET alike
/// (measured, W0 §10).
#[derive(Debug, Clone, Serialize)]
pub struct McpEndpoint {
    /// `http://127.0.0.1:<os-assigned port>/mcp`
    pub url: String,
    pub token: String,
}

/// One tool call the child made, for the trace panel: `claude -p` owns its own
/// loop, so this is the only record of what it actually reached for.
#[derive(Debug, Clone, Serialize)]
pub struct McpCall {
    pub tool: String,
    pub ms: f64,
    /// size of the text handed back to the model
    pub bytes: u64,
    pub is_error: bool,
}

type CallLog = Arc<Mutex<Vec<McpCall>>>;
type McpResult<T> = std::result::Result<T, McpError>;
/// Ok = the text the model sees; Err = the same, flagged `isError`.
pub type ToolText = std::result::Result<String, String>;

// ---------------------------------------------------------------------------
// tool surface
// ---------------------------------------------------------------------------

/// The five tools, over whatever executes them, plus the canvas family's one
/// door. The app's implementation runs the five on the thread's dedicated
/// read-only session and hands a canvas call to the app; tests substitute
/// their own, which is what lets the transport be tested without a database.
#[async_trait::async_trait]
pub trait McpToolBackend: Send + Sync + 'static {
    async fn list_tables(&self) -> ToolText;
    async fn describe_tables(&self, names: Vec<String>) -> ToolText;
    async fn peek_values(&self, table: String, column: String, limit: u32) -> ToolText;
    async fn run_sql(&self, sql: String) -> ToolText;
    async fn probe(&self, sqls: Vec<String>) -> ToolText;
    /// ONE method for all three canvas tools, not three: this side knows the
    /// name and the raw arguments and nothing else about them (§1.7).
    async fn canvas_call(&self, name: String, args_json: String) -> ToolText;
}

fn parse_tools(json: &str, key: &str) -> Option<Vec<Tool>> {
    let doc: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut out = Vec::new();
    for t in doc.get(key)?.as_array()? {
        out.push(Tool::new(
            t.get("name")?.as_str()?.to_string(),
            t.get("description")?.as_str()?.to_string(),
            // the parameters object goes over the wire whole, `$ref` and
            // `$defs` included: rmcp resolves nothing and strips nothing, so
            // a `$ref` only resolves for the child if its `$defs` sit inside
            // this same object (verified by `a_ref_and_its_defs_survive…`)
            Arc::new(t.get("parameters")?.as_object()?.clone()),
        ));
    }
    Some(out)
}

/// `tools.schema.json`'s `tools` as rmcp's wire type. A malformed file would
/// be a build time bug caught by `tool_schemas_json_carries_the_five_tools`;
/// at runtime an empty list is still better than a panic in a spawned
/// connection task.
fn tools() -> &'static Vec<Tool> {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| parse_tools(TOOL_SCHEMAS_JSON, "tools").unwrap_or_default())
}

/// The same file's `canvasTools`. A sibling key, not a sixth entry in `tools`:
/// that array is prompt surface for every HTTP provider and does not move
/// (EVAL §4).
fn canvas_tools() -> &'static Vec<Tool> {
    static CANVAS: OnceLock<Vec<Tool>> = OnceLock::new();
    CANVAS.get_or_init(|| parse_tools(TOOL_SCHEMAS_JSON, "canvasTools").unwrap_or_default())
}

/// The tools one token serves. `None` is every run without a canvas target,
/// and it returns the five in file order: the same `Vec` this file served
/// before the canvas family existed, which is what keeps a no-target
/// `claude -p` run byte-identical (§1.6). `Some(names)` is the list the loop
/// handed its provider, so the tools array is the gate and there is no second
/// flag to disagree with it.
fn tools_for(names: Option<&[String]>) -> Vec<Tool> {
    let Some(names) = names else {
        return tools().clone();
    };
    tools()
        .iter()
        .chain(canvas_tools().iter())
        .filter(|t| names.iter().any(|n| n == t.name.as_ref()))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// result text (the format every provider sees; tools_mcp.py / harness.py)
// ---------------------------------------------------------------------------

/// One relation as the model sees it. `display` is the name it reads and
/// writes back: bare unless the bare name collides across schemas. Mirrors
/// `buildMeta` in `src/agent/context.ts` field for field, because the text
/// built from it must be byte-identical to what every other provider sees.
#[derive(Debug, Clone)]
struct TableMeta {
    schema: String,
    name: String,
    display: String,
    columns: Vec<ColumnMeta>,
    pk: Vec<String>,
    comment: Option<String>,
    /// `reltuples`, rounded; -1 when the table was never analyzed, which is
    /// why the DDL header drops the row estimate instead of claiming zero
    approx_rows: i64,
}

#[derive(Debug, Clone)]
struct ColumnMeta {
    name: String,
    data_type: String,
    comment: Option<String>,
}

/// One single-column foreign key, in display names.
#[derive(Debug, Clone)]
struct FkMeta {
    src: String,
    src_col: String,
    dst: String,
    dst_col: String,
}

#[derive(Debug, Clone, Default)]
struct Meta {
    tables: Vec<TableMeta>,
    fks: Vec<FkMeta>,
}

/// Names past this are worse than a pointer at `list_tables`; matches
/// `nameList`'s limit in `tools.tauri.ts`.
const NAME_LIST_CAP: usize = 60;

/// The NULL marker the model reads. `tools.tauri.ts` uses the same glyph: a
/// blank cell would read as an empty string and quietly change the answer.
const NULL_CELL: &str = "∅";

impl Meta {
    /// Foreign tables are not queryable here and partition children are an
    /// implementation detail of their parent; views and matviews stay, because
    /// a curated view often IS the answer.
    fn build(snapshot: &SchemaSnapshot) -> Meta {
        let by_oid: HashMap<u32, &TableInfo> =
            snapshot.tables.iter().map(|t| (t.table_oid, t)).collect();
        let kept: Vec<&TableInfo> = snapshot
            .tables
            .iter()
            .filter(|t| {
                t.kind != "f"
                    && t.parent_oid
                        .and_then(|oid| by_oid.get(&oid))
                        .is_none_or(|p| p.kind != "p")
            })
            .collect();

        let mut bare_count: HashMap<&str, usize> = HashMap::new();
        for t in &kept {
            *bare_count.entry(t.name.as_str()).or_default() += 1;
        }

        let mut tables: Vec<TableMeta> = kept
            .iter()
            .map(|t| TableMeta {
                schema: t.schema.clone(),
                name: t.name.clone(),
                display: if bare_count.get(t.name.as_str()).copied().unwrap_or(0) > 1 {
                    format!("{}.{}", t.schema, t.name)
                } else {
                    t.name.clone()
                },
                columns: t
                    .columns
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        comment: c.comment.clone(),
                    })
                    .collect(),
                pk: t.pk.clone(),
                comment: t.comment.clone(),
                approx_rows: t.reltuples.map_or(-1, |r| (r.round() as i64).max(-1)),
            })
            .collect();
        tables.sort_by(|a, b| a.display.cmp(&b.display));

        let by_key: HashMap<String, &str> = tables
            .iter()
            .map(|t| (format!("{}.{}", t.schema, t.name), t.display.as_str()))
            .collect();
        // single-column keys only, as measured: the lab's graph is built from
        // `array_length(con.conkey, 1) = 1` and recall belongs to it
        let mut fks = Vec::new();
        for fk in &snapshot.foreign_keys {
            if fk.src_cols.len() != 1 || fk.dst_cols.len() != 1 {
                continue;
            }
            let (Some(src), Some(dst)) = (
                by_key.get(&format!("{}.{}", fk.src_schema, fk.src_table)),
                by_key.get(&format!("{}.{}", fk.dst_schema, fk.dst_table)),
            ) else {
                continue;
            };
            fks.push(FkMeta {
                src: (*src).to_string(),
                src_col: fk.src_cols[0].clone(),
                dst: (*dst).to_string(),
                dst_col: fk.dst_cols[0].clone(),
            });
        }
        Meta { tables, fks }
    }

    /// Resolve a name as the MODEL wrote it: bare, quoted, wrong case, or
    /// already qualified. The dotted form is only accepted when it matches a
    /// name the schema actually carries, never split blindly (LESSONS 4).
    fn resolve(&self, raw: &str) -> Option<&TableMeta> {
        let name = unquote(raw.trim());
        if let Some(t) = self.tables.iter().find(|t| t.display == name) {
            return Some(t);
        }
        let lower = name.to_lowercase();
        // each pass matches only when it is UNAMBIGUOUS: two tables with the
        // same bare name in different schemas must not silently pick one
        for key in [
            &|t: &TableMeta| t.name.to_lowercase(),
            &|t: &TableMeta| format!("{}.{}", t.schema, t.name).to_lowercase(),
            &|t: &TableMeta| t.display.to_lowercase(),
        ] as [&dyn Fn(&TableMeta) -> String; 3]
        {
            let mut hits = self.tables.iter().filter(|t| key(t) == lower);
            let first = hits.next();
            if let (Some(t), None) = (first, hits.next()) {
                return Some(t);
            }
        }
        None
    }

    /// Names the model may use, for an error that teaches rather than refuses.
    fn name_list(&self) -> String {
        let names: Vec<&str> = self.tables.iter().map(|t| t.display.as_str()).collect();
        if names.len() > NAME_LIST_CAP {
            format!(
                "{} … ({} in total)",
                names[..NAME_LIST_CAP].join(", "),
                names.len()
            )
        } else {
            names.join(", ")
        }
    }
}

impl TableMeta {
    fn column(&self, raw: &str) -> Option<&ColumnMeta> {
        let want = unquote(raw.trim()).to_lowercase();
        self.columns.iter().find(|c| c.name.to_lowercase() == want)
    }
}

fn unquote(s: &str) -> &str {
    s.strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(s)
}

fn unknown_table(meta: &Meta, name: &str) -> String {
    format!(
        "ERROR: unknown table '{name}'. Valid names: {}",
        meta.name_list()
    )
}

fn list_tables_text(meta: &Meta) -> String {
    meta.tables
        .iter()
        .map(|t| {
            let comment = t
                .comment
                .as_deref()
                .map(|c| format!("  -- {c}"))
                .unwrap_or_default();
            format!("{}  (~{} rows){comment}", t.display, t.approx_rows.max(0))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One column's `values:` fragment, or nothing when pg_stats had no usable
/// answer (the estimate was over the cap, or a value was too long to be a hint
/// rather than a payload).
fn values_note(values: Option<&ColumnValues>) -> Option<String> {
    let v = values?;
    if v.values.is_empty() {
        return None;
    }
    let list = v
        .values
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "values: {list}{}",
        if v.more { " … (more exist)" } else { "" }
    ))
}

/// The DDL text `describe_tables` returns: a CREATE TABLE per name, row
/// estimate and table comment on the header, PRIMARY KEY / REFERENCES inline,
/// and the column comment plus real stored values after the comma. A column
/// comment read live by the describe call wins over the cached snapshot's; the
/// header comment stays the snapshot's, which is the one the candidate block
/// quoted. Byte for byte `renderDescribe` in `src/agent/context.ts`.
fn describe_text(meta: &Meta, tables: &[&TableMeta], stats: &[TableValues]) -> String {
    let mut blocks = Vec::new();
    for t in tables {
        let stat = stats
            .iter()
            .find(|s| s.schema == t.schema && s.name == t.name);
        let head = [
            (t.approx_rows >= 0).then(|| format!("~{} rows", t.approx_rows)),
            t.comment.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ");
        let mut lines = vec![format!(
            "CREATE TABLE {} ({}",
            t.display,
            if head.is_empty() {
                String::new()
            } else {
                format!("  -- {head}")
            }
        )];

        let decls: Vec<(String, String)> = t
            .columns
            .iter()
            .map(|col| {
                let mut parts = vec![format!("  {} {}", col.name, col.data_type)];
                if t.pk.iter().any(|p| p == &col.name) {
                    parts.push("PRIMARY KEY".into());
                }
                if let Some(fk) = meta
                    .fks
                    .iter()
                    .find(|f| f.src == t.display && f.src_col == col.name)
                {
                    parts.push(format!("REFERENCES {}({})", fk.dst, fk.dst_col));
                }
                let live = stat.and_then(|s| s.columns.iter().find(|c| c.column == col.name));
                let note = [
                    live.and_then(|c| c.comment.clone())
                        .or_else(|| col.comment.clone()),
                    values_note(live),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; ");
                (parts.join(" "), note)
            })
            .collect();

        let last = decls.len().saturating_sub(1);
        for (i, (decl, note)) in decls.iter().enumerate() {
            let sep = if i < last { "," } else { "" };
            let note = if note.is_empty() {
                String::new()
            } else {
                format!("  -- {note}")
            };
            lines.push(format!("{decl}{sep}{note}"));
        }
        lines.push(");".into());
        blocks.push(lines.join("\n"));
    }
    blocks.join("\n\n")
}

fn peek_text(values: &[String], more: bool) -> String {
    if values.is_empty() {
        return "(no non-null values)".into();
    }
    let list = values
        .iter()
        .map(|v| format!("'{v}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{list}{}", if more { " … (more exist)" } else { "" })
}

/// header, up to `MODEL_ROW_CAP` rows, and a truthful count. Never fewer than
/// 50 rows: the lean variant looped to the turn cap re-querying what it could
/// not see (§5).
fn run_text(run: &crate::agent::AgentRun) -> String {
    let head = run.columns.join(" | ");
    let shown = run.rows.len().min(MODEL_ROW_CAP);
    let body = run.rows[..shown]
        .iter()
        .map(|r| {
            r.iter()
                .map(|c| c.as_deref().unwrap_or(NULL_CELL))
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let total = run.row_count;
    let tail = if run.capped {
        format!("({total} rows, capped at {}; showing {shown})", crate::agent::UI_ROW_CAP)
    } else if total as usize > shown {
        format!("({total} rows total, showing {shown})")
    } else {
        format!("({total} rows)")
    };
    format!("{head}\n{body}\n{tail}")
}

/// One block per query, each labelled with the SQL it came from: a probe batch
/// is only useful if the model can tell which answer belongs to which question.
fn probe_text(results: &[crate::agent::ProbeResult]) -> String {
    results
        .iter()
        .map(|p| {
            let body = match (&p.run, &p.error) {
                (Some(run), _) => run_text(run),
                (None, Some(e)) => format!("ERROR: {e}"),
                (None, None) => "ERROR: failed".to_string(),
            };
            format!("-- {}\n{body}", p.sql)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------------------------------------------------------------------------
// the app's backend: the thread's dedicated read-only session
// ---------------------------------------------------------------------------

/// Runs the tools through `agent.rs` on one thread's session. Holds an
/// `AppHandle` rather than a `State` because the handler outlives the command
/// call that created it, and resolves the session per call so a disconnect
/// between two tool calls is an error the model can read.
struct SessionBackend {
    app: tauri::AppHandle,
    session_id: String,
    /// this thread's bearer token, minted before the backend so a canvas call
    /// can name the caller the app registered its tools for (§2.2)
    token: String,
    /// the user's `statement_timeout` setting as it stood when the thread
    /// opened, so a `claude -p` tool call obeys the same limit the loop does
    timeout_ms: u64,
    /// one introspect per thread; the schema is what bare names resolve
    /// against, and re-fetching it per tool call would spend the turn budget
    meta: Mutex<Option<Arc<Meta>>>,
}

impl SessionBackend {
    fn session(&self) -> std::result::Result<Arc<PgSession>, String> {
        tauri::Manager::state::<AppState>(&self.app)
            .session(&self.session_id)
            .ok_or_else(|| "ERROR: this thread's connection is gone. Ask again to reopen it".into())
    }

    async fn meta(&self) -> std::result::Result<Arc<Meta>, String> {
        let cached = self.meta.lock().ok().and_then(|g| g.clone());
        if let Some(m) = cached {
            return Ok(m);
        }
        let session = self.session()?;
        // `Some(vec![])` skips the pg_catalog function partition: the tools
        // talk about tables, and 3k catalog functions are not that
        let (snapshot, _) = session
            .introspect(Some(Vec::new()))
            .await
            .map_err(tool_error)?;
        let meta = Arc::new(Meta::build(&snapshot));
        if let Ok(mut g) = self.meta.lock() {
            *g = Some(meta.clone());
        }
        Ok(meta)
    }
}

/// A tool failure is text the model reads and repairs from, in the same
/// `ERROR: <first line>` shape a real SQL error takes (§5).
fn tool_error(e: DriverError) -> String {
    format!("ERROR: {}", first_line(&e.to_string()))
}

#[async_trait::async_trait]
impl McpToolBackend for SessionBackend {
    async fn list_tables(&self) -> ToolText {
        let meta = self.meta().await?;
        Ok(list_tables_text(&meta))
    }

    async fn describe_tables(&self, names: Vec<String>) -> ToolText {
        let meta = self.meta().await?;
        let mut picked: Vec<&TableMeta> = Vec::new();
        for raw in &names {
            let Some(t) = meta.resolve(raw) else {
                return Err(unknown_table(&meta, raw));
            };
            if !picked.iter().any(|p| p.display == t.display) {
                picked.push(t);
            }
        }
        let refs: Vec<TableRef> = picked
            .iter()
            .map(|t| TableRef {
                schema: t.schema.clone(),
                name: t.name.clone(),
            })
            .collect();
        // pg_stats values are an accelerant, never the definition: losing them
        // costs sample values, not the DDL (LESSONS 5)
        let session = self.session()?;
        let stats = crate::agent::describe(&session, &refs).await.unwrap_or_default();
        Ok(describe_text(&meta, &picked, &stats))
    }

    async fn peek_values(&self, table: String, column: String, limit: u32) -> ToolText {
        let meta = self.meta().await?;
        let Some(t) = meta.resolve(&table) else {
            return Err(unknown_table(&meta, &table));
        };
        let Some(col) = t.column(&column) else {
            let cols: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).collect();
            return Err(format!(
                "ERROR: no column '{column}' on {}. Columns: {}",
                t.display,
                cols.join(", ")
            ));
        };
        let session = self.session()?;
        let peek = crate::agent::peek_values(&session, &t.schema, &t.name, &col.name, limit)
            .await
            .map_err(tool_error)?;
        Ok(peek_text(&peek.values, peek.more))
    }

    async fn run_sql(&self, sql: String) -> ToolText {
        let session = self.session()?;
        let run = crate::agent::run_readonly(
            &session,
            &sql,
            crate::agent::UI_ROW_CAP,
            self.timeout_ms,
        )
        .await
        .map_err(tool_error)?;
        Ok(run_text(&run))
    }

    async fn probe(&self, sqls: Vec<String>) -> ToolText {
        // truncate rather than refuse, as `tools.tauri.ts` does: a model that
        // asked for a seventh probe still deserves the first six answers
        let asked: Vec<String> = sqls.into_iter().take(crate::agent::PROBE_MAX).collect();
        let session = self.session()?;
        let results = crate::agent::probe(&session, &asked).await.map_err(tool_error)?;
        Ok(probe_text(&results))
    }

    /// Straight over the bridge. No validation, no cap, no block: the app
    /// answers with the same text the driven path's tool would (§1.7).
    async fn canvas_call(&self, name: String, args_json: String) -> ToolText {
        crate::agent_canvas::call(&self.app, &self.token, &self.session_id, name, args_json).await
    }
}

/// PostgreSQL errors carry a DETAIL/HINT tail the model does not need and a
/// first line that is the whole diagnosis.
fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or(s).trim()
}

// ---------------------------------------------------------------------------
// the rmcp handler
// ---------------------------------------------------------------------------

/// One thread's MCP handler. Cloned per request in stateless mode, so every
/// field is a shared handle or a copy rather than owned state.
#[derive(Clone)]
struct QwryMcp {
    backend: Arc<dyn McpToolBackend>,
    log: CallLog,
    /// what THIS token serves, fixed when it was minted. `list_tools` answers
    /// from here and never from the global list, so two threads of one app can
    /// offer different tools, and the served list is the only gate: the tools
    /// array IS the target (§1.6)
    tools: Arc<Vec<Tool>>,
}

impl QwryMcp {
    /// The five are the app's floor and keep their unconditional arms. A
    /// canvas tool is answered only by a token that serves it, so a thread
    /// with no target reads the unknown-tool error and is never taught that
    /// the tool exists.
    fn serves(&self, name: &str) -> bool {
        self.tools.iter().any(|t| t.name.as_ref() == name)
    }

    fn record(&self, tool: &str, started: Instant, text: &str, is_error: bool) {
        if let Ok(mut log) = self.log.lock() {
            if log.len() >= CALL_LOG_CAP {
                log.remove(0);
            }
            log.push(McpCall {
                tool: tool.to_string(),
                ms: started.elapsed().as_secs_f64() * 1000.0,
                bytes: text.len() as u64,
                is_error,
            });
        }
    }

    async fn dispatch(&self, name: &str, args: &JsonObject) -> ToolText {
        match name {
            "list_tables" => self.backend.list_tables().await,
            "describe_tables" => {
                let names = string_array(args, "names")?;
                self.backend.describe_tables(names).await
            }
            "peek_values" => {
                let table = string(args, "table")?;
                let column = string(args, "column")?;
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(20)
                    .clamp(1, u64::from(crate::agent::PEEK_MAX)) as u32;
                self.backend.peek_values(table, column, limit).await
            }
            "run_sql" => {
                let sql = string(args, "sql")?;
                self.backend.run_sql(sql).await
            }
            "probe" => {
                let sqls = string_array(args, "sqls")?;
                self.backend.probe(sqls).await
            }
            canvas
                if crate::agent_canvas::CANVAS_TOOL_NAMES.contains(&canvas)
                    && self.serves(canvas) =>
            {
                // the arguments go over as the model wrote them: every cap and
                // every refusal text belongs to the TypeScript tool
                let args = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
                self.backend.canvas_call(canvas.to_string(), args).await
            }
            other => Err(format!(
                "ERROR: unknown tool '{other}'. Valid tools: {}",
                self.tools
                    .iter()
                    .map(|t| t.name.as_ref())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
}

/// Tool arguments are untrusted text: a missing or mistyped field is an error
/// the model reads and fixes, never a panic and never a protocol error.
fn string(args: &JsonObject, key: &str) -> std::result::Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("ERROR: '{key}' is required and must be a string"))
}

fn string_array(args: &JsonObject, key: &str) -> std::result::Result<Vec<String>, String> {
    let arr = args
        .get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("ERROR: '{key}' is required and must be an array of strings"))?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| format!("ERROR: every entry of '{key}' must be a string"))
        })
        .collect()
}

impl ServerHandler for QwryMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> McpResult<ListToolsResult> {
        Ok(ListToolsResult::with_all_items(self.tools.as_ref().clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> McpResult<CallToolResponse> {
        let started = Instant::now();
        let args = request.arguments.clone().unwrap_or_default();
        let outcome = self.dispatch(&request.name, &args).await;
        // a failed tool call is normal: the text goes back to the model in
        // the shape the repair loop expects, never as a JSON-RPC error
        let (text, is_error) = match outcome {
            Ok(text) => (text, false),
            Err(text) => (text, true),
        };
        self.record(&request.name, started, &text, is_error);
        let content = vec![ContentBlock::text(text)];
        Ok(if is_error {
            CallToolResult::error(content).into()
        } else {
            CallToolResult::success(content).into()
        })
    }
}

// ---------------------------------------------------------------------------
// listener, token map, and the auth/origin gate in front of rmcp
// ---------------------------------------------------------------------------

type McpService = StreamableHttpService<QwryMcp, LocalSessionManager>;

struct TokenEntry {
    session_id: String,
    log: CallLog,
    service: McpService,
}

#[derive(Default)]
struct Registry {
    port: Option<u16>,
    tokens: HashMap<String, TokenEntry>,
}

fn registry() -> &'static Mutex<Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Registry::default()))
}

fn poisoned() -> DriverError {
    DriverError::Internal("the MCP server registry is unavailable".into())
}

fn body(text: &'static str) -> BoxBody<Bytes, Infallible> {
    Full::new(Bytes::from_static(text.as_bytes())).boxed()
}

fn refuse(status: StatusCode, text: &'static str) -> Response<BoxBody<Bytes, Infallible>> {
    let mut resp = Response::new(body(text));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

/// MCP's DNS-rebinding defence. An absent `Origin` is a non-browser client
/// (`claude -p` sends none) and passes; anything else must be loopback over
/// plain http, which is the only place this listener exists.
fn origin_allowed(origin: Option<&HeaderValue>) -> bool {
    let Some(origin) = origin else { return true };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split(':').next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost")
}

fn bearer(headers: &http::HeaderMap) -> Option<String> {
    let raw = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = raw.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim().to_string())
}

/// One request: origin, then token, then rmcp. Unknown headers are passed
/// straight through, because `claude -p` 2.1.260 opens with a `server/discover`
/// preflight carrying headers older revisions never defined (W0).
async fn gate(
    req: Request<hyper::body::Incoming>,
) -> std::result::Result<Response<BoxBody<Bytes, Infallible>>, Infallible> {
    if !origin_allowed(req.headers().get(ORIGIN)) {
        return Ok(refuse(StatusCode::FORBIDDEN, "forbidden origin"));
    }
    let service = bearer(req.headers()).and_then(|token| {
        registry()
            .lock()
            .ok()
            .and_then(|reg| reg.tokens.get(&token).map(|e| e.service.clone()))
    });
    let Some(service) = service else {
        return Ok(refuse(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    if req
        .headers()
        .get("mcp-method")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|m| m == "server/discover")
    {
        return Ok(decline_discover(req).await);
    }
    if std::env::var_os("QWRY_MCP_TRACE").is_some() {
        return Ok(traced(service, req).await);
    }
    TowerToHyperService::new(service).call(req).await
}

/// The 2026-07-28 revision is declined on purpose. rmcp 3.2.0 and Claude Code
/// 2.1.261 both speak it, and together they fail: the CLI's `server/discover`
/// probe succeeds, it then asks `tools/list` four times, receives the five
/// tools each time, and still starts the model with an EMPTY tool list, which
/// the model answers by writing tool calls as prose and inventing rows
/// (measured 2026-09-05 with QWRY_MCP_TRACE=1). Refusing the probe with
/// JSON-RPC "method not found" makes the CLI fall back to `initialize` at
/// 2025-11-25, the revision every measured run (W0, the eval baseline) used.
/// Re-test when either side ships a fix: the end-to-end test is
/// `claude_p_end_to_end_lists_and_calls_the_tools`.
async fn decline_discover(
    req: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, Infallible>> {
    let bytes = req
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    let id = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": "server/discover is not offered here; initialize at 2025-11-25"
        }
    })
    .to_string();
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed())
        .unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR, "response"))
}

/// Diagnostic only (`QWRY_MCP_TRACE=1`): every request and response on the
/// wire, headers and bodies, to stderr. Buffers both bodies, so never on by
/// default; it exists because the CLI reports a server it cannot use as
/// "connected" and nothing else shows why.
async fn traced(
    service: McpService,
    req: Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, Infallible>> {
    use http_body_util::{BodyExt, Full};
    let (parts, body) = req.into_parts();
    let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    eprintln!(
        "MCP> {} {} {:?}\nMCP> {}",
        parts.method,
        parts.uri,
        parts.headers,
        String::from_utf8_lossy(&bytes)
    );
    let req = Request::from_parts(parts, Full::new(bytes));
    let resp = match TowerToHyperService::new(service).call(req).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("MCP< service error: {e:?}");
            return refuse(StatusCode::INTERNAL_SERVER_ERROR, "service error");
        }
    };
    let (parts, body) = resp.into_parts();
    let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    eprintln!(
        "MCP< {} {:?}\nMCP< {}",
        parts.status,
        parts.headers,
        String::from_utf8_lossy(&bytes)
    );
    Response::from_parts(parts, Full::new(bytes).map_err(|never| match never {}).boxed())
}

/// Bind a fresh loopback listener and serve every connection on it until the
/// process ends. Synchronous on purpose: binding under the registry lock is
/// what makes "one listener per app" true even if two threads open at once.
/// Must be called from inside the tokio runtime (every Tauri command is).
fn bind_listener() -> Result<u16> {
    let failed = |e: std::io::Error| {
        DriverError::Internal(format!("couldn't start the tool server. {e}"))
    };
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(failed)?;
    std_listener.set_nonblocking(true).map_err(failed)?;
    let port = std_listener.local_addr().map_err(failed)?.port();
    let listener = TcpListener::from_std(std_listener).map_err(failed)?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, hyper::service::service_fn(gate))
                    .await;
            });
        }
    });
    Ok(port)
}

/// The app's one listener, bound on first Ask use.
fn ensure_listener() -> Result<u16> {
    let mut reg = registry().lock().map_err(|_| poisoned())?;
    if let Some(port) = reg.port {
        return Ok(port);
    }
    let port = bind_listener()?;
    reg.port = Some(port);
    Ok(port)
}

fn mint_token() -> String {
    // 32 bytes of entropy from two v4 uuids: `uuid` is already a dependency,
    // and a CSPRNG-backed 244 bits is well past what a loopback bearer needs
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Bind `token` to `backend` and return the endpoint it answers on. Any
/// listener serves any token, so `port` is only what the URL advertises. The
/// token is an argument rather than minted here because the backend needs to
/// know its own name before it can emit a canvas call under it (§2.2).
fn register_backend(
    port: u16,
    session_id: &str,
    token: String,
    tools: Vec<Tool>,
    backend: Arc<dyn McpToolBackend>,
) -> Result<McpEndpoint> {
    let log: CallLog = Arc::new(Mutex::new(Vec::new()));
    let handler = QwryMcp {
        backend,
        log: log.clone(),
        tools: Arc::new(tools),
    };
    let config = StreamableHttpServerConfig::default()
        // never issue an Mcp-Session-Id: the CLI opens session-less and the
        // token is the identity (DECISIONS 2026-09-05)
        .with_legacy_session_mode(false)
        // this server never pushes a message of its own, so a plain JSON body
        // per POST is legal and one round trip cheaper than an SSE frame
        .with_json_response(true)
        .with_allowed_hosts(["127.0.0.1", "localhost"]);
    let service = StreamableHttpService::new(
        move || Ok(handler.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    );

    registry().lock().map_err(|_| poisoned())?.tokens.insert(
        token.clone(),
        TokenEntry {
            session_id: session_id.to_string(),
            log,
            service,
        },
    );
    Ok(McpEndpoint {
        url: format!("http://127.0.0.1:{port}{MCP_PATH}"),
        token,
    })
}

/// Start the server if it is not running, mint a bearer token bound to
/// `session_id`, and return the endpoint for this thread. `timeout_ms` is the
/// user's `statement_timeout` setting; `None` takes the §5 default, because a
/// tool call cannot reach `useSettings` from the child process. `tools` is the
/// list the loop handed this exchange's provider, by name; `None` serves the
/// five, which is every run without a canvas target (§1.6).
#[tauri::command]
pub async fn agent_mcp_serve(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    timeout_ms: Option<u64>,
    tools: Option<Vec<String>>,
) -> Result<McpEndpoint> {
    // fail here rather than on the child's first tool call: a dead MCP server
    // is invisible to `claude -p`, which exits 0 with a toolless model (W0 §7)
    if state.session(&session_id).is_none() {
        return Err(DriverError::NoSession);
    }
    let port = ensure_listener()?;
    let token = mint_token();
    let backend = Arc::new(SessionBackend {
        app,
        session_id: session_id.clone(),
        token: token.clone(),
        timeout_ms: timeout_ms.unwrap_or(RUN_SQL_TIMEOUT_MS),
        meta: Mutex::new(None),
    });
    register_backend(port, &session_id, token, tools_for(tools.as_deref()), backend)
}

/// Revoke one thread's token. The listener stays up for other threads;
/// an unknown token is a no-op. Any canvas call still parked for this token
/// is dropped with an error rather than left to wait out its timeout: the
/// exchange that could have answered it is over (`agent_canvas.rs`).
#[tauri::command]
pub async fn agent_mcp_stop(token: String) -> Result<()> {
    registry().lock().map_err(|_| poisoned())?.tokens.remove(&token);
    crate::agent_canvas::drop_parked(&token);
    Ok(())
}

/// Every tool call this thread's child made, oldest first. `claude -p` owns
/// its own loop, so without this the trace panel could only show what qwry
/// sent, not what the model reached for (§8.4).
#[tauri::command]
pub async fn agent_mcp_log(token: String) -> Result<Vec<McpCall>> {
    let log = registry()
        .lock()
        .map_err(|_| poisoned())?
        .tokens
        .get(&token)
        .map(|e| e.log.clone());
    let Some(log) = log else {
        return Ok(Vec::new());
    };
    let calls = log.lock().map_err(|_| poisoned())?.clone();
    Ok(calls)
}

/// The database session a token speaks for. The map entry dies with the
/// thread, so a child calling back into a torn-down thread finds nothing.
pub fn session_for_token(token: &str) -> Option<String> {
    registry()
        .lock()
        .ok()?
        .tokens
        .get(token)
        .map(|e| e.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The five, in file order. Written out rather than read from the file so
    /// a test that pins the served list has something to pin it against.
    const FIVE: [&str; 5] = [
        "list_tables",
        "describe_tables",
        "peek_values",
        "run_sql",
        "probe",
    ];

    fn names_of(tools: &[Tool]) -> Vec<&str> {
        tools.iter().map(|t| t.name.as_ref()).collect()
    }

    fn asked(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_string()).collect()
    }

    /// tools.schema.json is the contract with TypeScript (`src/agent/tools.ts`
    /// imports the same file). If it stops parsing, loses a tool, or is moved,
    /// the MCP surface and every other provider's tool list silently diverge,
    /// which reads to the model as a different app.
    #[test]
    fn tool_schemas_json_carries_the_five_tools() {
        let doc: serde_json::Value =
            serde_json::from_str(TOOL_SCHEMAS_JSON).expect("tools.schema.json is valid JSON");
        let names: Vec<&str> = doc["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|t| t["name"].as_str().expect("tool name"))
            .collect();
        assert_eq!(
            names,
            ["list_tables", "describe_tables", "peek_values", "run_sql", "probe"]
        );
    }

    /// The wire types are built from that same file, not from a second copy:
    /// a schema that parses into an empty list would serve a toolless server
    /// and `claude -p` would never say so (W0 §7).
    #[test]
    fn the_served_tools_come_from_the_shared_schema_file() {
        assert_eq!(names_of(tools()), FIVE);
        assert_eq!(names_of(&tools_for(None)), FIVE);
        let run_sql = tools().iter().find(|t| t.name == "run_sql").expect("run_sql");
        assert_eq!(
            run_sql.input_schema.get("required").and_then(|v| v.as_array()),
            Some(&vec![serde_json::json!("sql")])
        );
        assert!(run_sql
            .description
            .as_deref()
            .is_some_and(|d| d.contains("read-only")));
    }

    /// THE BYTE PIN. A token with no canvas list serves what this file served
    /// before the canvas family existed: `ListToolsResult` over the global
    /// list, serialized. The five schemas are prompt surface for every
    /// provider (EVAL §4) and `claude -p` reads them off this wire, so the
    /// expectation is HEAD's own expression, kept here on purpose.
    #[test]
    fn a_token_with_no_canvas_list_serves_the_five_byte_for_byte() {
        let head = serde_json::to_string(&ListToolsResult::with_all_items(tools().clone()))
            .expect("serialize");
        let served = serde_json::to_string(&ListToolsResult::with_all_items(tools_for(None)))
            .expect("serialize");
        assert_eq!(served, head);
        assert!(!served.contains("canvas"));

        // and those bytes are the file's own, not a paraphrase of them
        let doc: serde_json::Value =
            serde_json::from_str(TOOL_SCHEMAS_JSON).expect("tools.schema.json");
        let wire: serde_json::Value = serde_json::from_str(&served).expect("wire");
        let listed = wire["tools"].as_array().expect("wire tools");
        assert_eq!(listed.len(), FIVE.len());
        for (i, t) in doc["tools"].as_array().expect("file tools").iter().enumerate() {
            assert_eq!(listed[i]["name"], t["name"]);
            assert_eq!(listed[i]["description"], t["description"]);
            assert_eq!(listed[i]["inputSchema"], t["parameters"]);
        }
    }

    /// The canvas family is advertised from the same file, under its own key,
    /// and the names it advertises are the three the bridge routes: a fourth
    /// name in the file would be a tool the child can see and this side
    /// answers with the unknown-tool error.
    #[test]
    fn the_canvas_tools_come_from_the_shared_schema_file() {
        assert_eq!(
            names_of(canvas_tools()),
            crate::agent_canvas::CANVAS_TOOL_NAMES
        );
        let write = canvas_tools()
            .iter()
            .find(|t| t.name == "canvas_write")
            .expect("canvas_write");
        assert!(write.input_schema.get("properties").is_some());
    }

    /// A token that asked for the canvas family is served the five first, in
    /// file order, then the family: the model reads the tools it has always
    /// had before the ones this wave adds.
    #[test]
    fn a_token_that_asks_for_the_canvas_family_is_served_it_after_the_five() {
        let all = asked(&[
            "list_tables",
            "describe_tables",
            "peek_values",
            "run_sql",
            "probe",
            "canvas_write",
            "canvas_replace",
            "canvas_read",
        ]);
        let served = tools_for(Some(&all));
        let expected: Vec<&str> = FIVE
            .iter()
            .copied()
            .chain(canvas_tools().iter().map(|t| t.name.as_ref()))
            .collect();
        assert_eq!(names_of(&served), expected);
        assert_eq!(names_of(&served)[..5], FIVE);
        assert_eq!(served.len(), 5 + canvas_tools().len());

        // the same list minus the canvas names is the no-target list again
        assert_eq!(names_of(&tools_for(Some(&asked(&FIVE)))), FIVE);
        // a name this app does not have is not a tool it serves
        assert_eq!(names_of(&tools_for(Some(&asked(&["run_sql", "nope"])))), ["run_sql"]);
    }

    /// `Tool::new` takes the parameters object whole, so whatever the schema
    /// file puts there is what the child sees: rmcp resolves no `$ref` and
    /// strips no `$defs`. Which means a `$ref` in a canvas tool's parameters
    /// resolves for the child ONLY if its `$defs` sit inside that same
    /// object, next to the `$ref` (canvas-agent-spec §1.3, §6 item 8).
    #[test]
    fn a_ref_and_its_defs_survive_the_wire_verbatim() {
        let file = serde_json::json!({
            "tools": [{
                "name": "canvas_write",
                "description": "d",
                "parameters": {
                    "type": "object",
                    "properties": { "blocks": { "items": { "$ref": "#/$defs/block" } } },
                    "$defs": { "block": { "type": "object" } }
                }
            }]
        });
        let parsed = parse_tools(&file.to_string(), "tools").expect("parse");
        let wire = serde_json::to_value(ListToolsResult::with_all_items(parsed)).expect("wire");
        let schema = &wire["tools"][0]["inputSchema"];
        assert_eq!(schema["properties"]["blocks"]["items"]["$ref"], "#/$defs/block");
        assert_eq!(schema["$defs"]["block"]["type"], "object");
    }

    /// Which is why no schema this server serves may point at a `$defs` that
    /// is not in the same object: the file's own `$defs` would sit beside
    /// `tools`, one level above anything the child ever receives, and the
    /// pointer would dangle. The canvas tools inline their union instead.
    #[test]
    fn no_served_schema_points_at_defs_it_does_not_carry() {
        for t in tools().iter().chain(canvas_tools().iter()) {
            let schema = serde_json::to_value(t.input_schema.as_ref()).expect("schema");
            if schema.to_string().contains("\"$ref\"") {
                assert!(
                    schema.get("$defs").is_some(),
                    "{} points at $defs it does not carry",
                    t.name
                );
            }
        }
    }

    #[test]
    fn a_loopback_origin_passes_and_anything_else_does_not() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some(&HeaderValue::from_static("http://127.0.0.1"))));
        assert!(origin_allowed(Some(&HeaderValue::from_static("http://localhost:5173"))));
        assert!(!origin_allowed(Some(&HeaderValue::from_static("http://evil.example"))));
        assert!(!origin_allowed(Some(&HeaderValue::from_static("https://127.0.0.1"))));
        assert!(!origin_allowed(Some(&HeaderValue::from_static("null"))));
    }

    #[test]
    fn the_bearer_scheme_is_read_case_insensitively_and_nothing_else_is() {
        let mut h = http::HeaderMap::new();
        h.insert(AUTHORIZATION, HeaderValue::from_static("Bearer abc"));
        assert_eq!(bearer(&h).as_deref(), Some("abc"));
        h.insert(AUTHORIZATION, HeaderValue::from_static("bearer abc"));
        assert_eq!(bearer(&h).as_deref(), Some("abc"));
        h.insert(AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&h), None);
        assert_eq!(bearer(&http::HeaderMap::new()), None);
    }

    #[test]
    fn tokens_are_unique_and_long_enough_to_be_a_secret() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn run_text_shows_fifty_rows_and_says_how_many_there_were() {
        let run = crate::agent::AgentRun {
            columns: vec!["id".into(), "name".into()],
            rows: (0..120)
                .map(|i| vec![Some(i.to_string()), None])
                .collect(),
            row_count: 120,
            capped: false,
            ms: 1.0,
        };
        let text = run_text(&run);
        assert!(text.starts_with("id | name\n0 | ∅\n"));
        assert!(text.ends_with("(120 rows total, showing 50)"));
        assert_eq!(text.lines().count(), 1 + MODEL_ROW_CAP + 1);

        // an empty result still carries its header and a truthful count
        let empty = crate::agent::AgentRun {
            columns: vec!["id".into()],
            rows: vec![],
            row_count: 0,
            capped: false,
            ms: 0.2,
        };
        assert_eq!(run_text(&empty), "id\n\n(0 rows)");

        // the cap the UI grid stopped at is named, not implied
        let capped = crate::agent::AgentRun {
            columns: vec!["id".into()],
            rows: (0..60).map(|i| vec![Some(i.to_string())]).collect(),
            row_count: 2000,
            capped: true,
            ms: 9.0,
        };
        assert!(run_text(&capped).ends_with("(2000 rows, capped at 2000; showing 50)"));
    }

    /// A snapshot shaped like the one `introspect` returns, small enough to
    /// pin the exact text the model reads.
    fn snapshot() -> SchemaSnapshot {
        let col = |name: &str, ty: &str, comment: Option<&str>| {
            serde_json::json!({
                "name": name, "attnum": 1, "type": ty, "type_oid": 23,
                "not_null": true, "default": null,
                "comment": comment
            })
        };
        serde_json::from_value(serde_json::json!({
            "tables": [
                {
                    "table_oid": 1, "schema": "public", "name": "film", "kind": "r",
                    "reltuples": 1000.0, "comment": "one row per title",
                    "pk": ["film_id"],
                    "columns": [
                        col("film_id", "integer", None),
                        col("rating", "mpaa_rating", None),
                        col("language_id", "smallint", Some("spoken language"))
                    ]
                },
                {
                    "table_oid": 2, "schema": "public", "name": "language", "kind": "r",
                    "reltuples": 6.0, "pk": ["language_id"],
                    "columns": [col("language_id", "smallint", None)]
                },
                {
                    "table_oid": 3, "schema": "public", "name": "events", "kind": "p",
                    "reltuples": 500.0, "columns": []
                },
                {
                    "table_oid": 6, "schema": "public", "name": "events_2024", "kind": "r",
                    "reltuples": 12.0, "parent_oid": 3, "columns": []
                },
                {
                    "table_oid": 4, "schema": "sales", "name": "orders", "kind": "r",
                    "reltuples": 52.0, "columns": []
                },
                {
                    "table_oid": 5, "schema": "public", "name": "orders", "kind": "r",
                    "reltuples": -1.0, "columns": []
                }
            ],
            "foreign_keys": [{
                "src_schema": "public", "src_table": "film", "src_cols": ["language_id"],
                "dst_schema": "public", "dst_table": "language", "dst_cols": ["language_id"]
            }],
            "functions": [], "schemas": ["public", "sales"]
        }))
        .expect("snapshot fixture")
    }

    /// A partition child is its parent's business, and a bare name that
    /// collides across schemas is qualified for BOTH sides, exactly as
    /// `buildMeta` does it: the model must never see two rows spelled `orders`.
    #[test]
    fn the_schema_the_model_sees_matches_build_meta() {
        let meta = Meta::build(&snapshot());
        assert_eq!(
            meta.tables.iter().map(|t| t.display.as_str()).collect::<Vec<_>>(),
            ["events", "film", "language", "public.orders", "sales.orders"]
        );
        assert_eq!(meta.fks.len(), 1);
        assert_eq!(meta.fks[0].dst, "language");
        // never analyzed stays -1 so the DDL header can drop the estimate
        assert_eq!(
            meta.resolve("public.orders").map(|t| t.approx_rows),
            Some(-1)
        );
    }

    #[test]
    fn list_tables_names_rows_and_comments_and_hides_partition_children() {
        assert_eq!(
            list_tables_text(&Meta::build(&snapshot())).lines().collect::<Vec<_>>(),
            [
                "events  (~500 rows)",
                "film  (~1000 rows)  -- one row per title",
                "language  (~6 rows)",
                "public.orders  (~0 rows)",
                "sales.orders  (~52 rows)",
            ]
        );
    }

    #[test]
    fn describe_tables_renders_the_ddl_shape_the_measured_runs_were_scored_on() {
        let meta = Meta::build(&snapshot());
        let film = meta.resolve("film").expect("film");
        let stats = vec![TableValues {
            schema: "public".into(),
            name: "film".into(),
            comment: None,
            columns: vec![ColumnValues {
                column: "rating".into(),
                values: vec!["G".into(), "PG".into()],
                more: false,
                comment: None,
            }],
        }];
        assert_eq!(
            describe_text(&meta, &[film], &stats).lines().collect::<Vec<_>>(),
            [
                "CREATE TABLE film (  -- ~1000 rows; one row per title",
                "  film_id integer PRIMARY KEY,",
                "  rating mpaa_rating,  -- values: 'G', 'PG'",
                "  language_id smallint REFERENCES language(language_id)  -- spoken language",
                ");",
            ]
        );
        // a never-analyzed table drops the estimate rather than claiming zero
        let orders = meta.resolve("public.orders").expect("orders");
        assert_eq!(describe_text(&meta, &[orders], &[]), "CREATE TABLE public.orders (\n);");
    }

    #[test]
    fn a_comment_read_by_the_describe_call_outranks_the_cached_snapshots() {
        let meta = Meta::build(&snapshot());
        let film = meta.resolve("film").expect("film");
        let stats = vec![TableValues {
            schema: "public".into(),
            name: "film".into(),
            comment: None,
            columns: vec![ColumnValues {
                column: "language_id".into(),
                values: vec![],
                more: false,
                comment: Some("added since the last introspect".into()),
            }],
        }];
        let ddl = describe_text(&meta, &[film], &stats);
        assert!(ddl.contains("  -- added since the last introspect"), "{ddl}");
        assert!(!ddl.contains("spoken language"), "{ddl}");
    }

    #[test]
    fn a_bare_name_resolves_quoted_and_miscased_and_an_unknown_one_teaches() {
        let meta = Meta::build(&snapshot());
        for written in ["film", "FILM", "\"film\"", " film ", "public.film"] {
            assert_eq!(
                meta.resolve(written).map(|t| t.display.as_str()),
                Some("film"),
                "{written}"
            );
        }
        assert_eq!(
            meta.resolve("sales.orders").map(|t| t.display.as_str()),
            Some("sales.orders")
        );
        // ambiguous bare name: qualified or nothing, never a silent pick
        assert!(meta.resolve("orders").is_none());
        // a partition child is not a table the model can name; its parent is
        assert!(meta.resolve("events_2024").is_none());
        assert!(meta.resolve("events").is_some());
        assert_eq!(
            unknown_table(&meta, "flim"),
            "ERROR: unknown table 'flim'. \
             Valid names: events, film, language, public.orders, sales.orders"
        );
    }

    #[test]
    fn probe_reports_each_query_separately_and_a_failure_does_not_hide_the_rest() {
        let results = vec![
            crate::agent::ProbeResult {
                sql: "SELECT 1 AS n".into(),
                run: Some(crate::agent::AgentRun {
                    columns: vec!["n".into()],
                    rows: vec![vec![Some("1".into())]],
                    row_count: 1,
                    capped: false,
                    ms: 0.4,
                }),
                error: None,
            },
            crate::agent::ProbeResult {
                sql: "SELECT bad".into(),
                run: None,
                error: Some("column \"bad\" does not exist".into()),
            },
        ];
        assert_eq!(
            probe_text(&results).lines().collect::<Vec<_>>(),
            [
                "-- SELECT 1 AS n",
                "n",
                "1",
                "(1 rows)",
                "",
                "-- SELECT bad",
                "ERROR: column \"bad\" does not exist",
            ]
        );
    }

    #[test]
    fn peek_text_marks_a_truncated_list() {
        assert_eq!(peek_text(&[], false), "(no non-null values)");
        assert_eq!(peek_text(&["a".into(), "b".into()], false), "'a', 'b'");
        assert_eq!(peek_text(&["a".into()], true), "'a' … (more exist)");
    }

    // ---- the transport itself, over a real socket -------------------------

    struct FakeTools;

    #[async_trait::async_trait]
    impl McpToolBackend for FakeTools {
        async fn list_tables(&self) -> ToolText {
            Ok("film  (~1000 rows)".into())
        }
        async fn describe_tables(&self, names: Vec<String>) -> ToolText {
            Err(format!("ERROR: unknown table '{}'", names.join(",")))
        }
        async fn peek_values(&self, _t: String, _c: String, _l: u32) -> ToolText {
            Ok("'a'".into())
        }
        async fn run_sql(&self, sql: String) -> ToolText {
            Ok(format!("ran: {sql}"))
        }
        async fn probe(&self, sqls: Vec<String>) -> ToolText {
            Ok(format!("{} probes", sqls.len()))
        }
        /// stands in for the app on the other side of the bridge: the name and
        /// the model's raw arguments, which is everything this side hands over
        async fn canvas_call(&self, name: String, args_json: String) -> ToolText {
            Ok(format!("{name} {args_json}"))
        }
    }

    async fn post(
        endpoint: &McpEndpoint,
        token: &str,
        payload: serde_json::Value,
    ) -> reqwest::Response {
        reqwest::Client::new()
            .post(&endpoint.url)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(&payload)
            .send()
            .await
            .expect("request")
    }

    fn rpc(id: u32, method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    }

    /// Every `#[tokio::test]` owns a runtime that dies with the test, and a
    /// listener spawned on it dies too. The app has exactly one runtime, so it
    /// shares one listener; a test binds its own and registers into the same
    /// token map, which is what the gate actually routes on.
    fn endpoint_for(session: &str, backend: Arc<dyn McpToolBackend>) -> McpEndpoint {
        endpoint_serving(session, backend, None)
    }

    /// `tools` is what the loop offered this exchange's provider, by name:
    /// `None` is a thread with no canvas target.
    fn endpoint_serving(
        session: &str,
        backend: Arc<dyn McpToolBackend>,
        tools: Option<&[String]>,
    ) -> McpEndpoint {
        let port = bind_listener().expect("listen");
        register_backend(port, session, mint_token(), tools_for(tools), backend).expect("register")
    }

    fn init_params() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "qwry-test", "version": "0"}
        })
    }

    #[tokio::test]
    async fn the_discover_probe_is_declined_so_the_cli_falls_back_to_initialize() {
        let endpoint = endpoint_for("session-discover", Arc::new(FakeTools));
        let client = reqwest::Client::new();
        let resp = client
            .post(&endpoint.url)
            .header("authorization", format!("Bearer {}", endpoint.token))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-method", "server/discover")
            .header("mcp-protocol-version", "2026-07-28")
            .body(r#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{}}"#)
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status(), 200);
        let v: serde_json::Value = resp.json().await.expect("json");
        assert_eq!(v["id"], "server-discover-probe-1");
        assert_eq!(v["error"]["code"], -32601);
        assert!(v["result"].is_null());
    }

    #[tokio::test]
    async fn initialize_and_tools_list_and_tools_call_over_http() {
        let endpoint = endpoint_for("session-1", Arc::new(FakeTools));

        let init: serde_json::Value = post(&endpoint, &endpoint.token, rpc(1, "initialize", init_params()))
            .await
            .json()
            .await
            .expect("initialize json");
        assert_eq!(init["result"]["serverInfo"]["name"], "qwry");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");

        let listed: serde_json::Value =
            post(&endpoint, &endpoint.token, rpc(2, "tools/list", serde_json::json!({})))
                .await
                .json()
                .await
                .expect("tools/list json");
        let names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            names,
            ["list_tables", "describe_tables", "peek_values", "run_sql", "probe"]
        );
        assert!(listed["result"]["tools"][3]["inputSchema"]["properties"]["sql"].is_object());

        let called: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                3,
                "tools/call",
                serde_json::json!({"name": "run_sql", "arguments": {"sql": "SELECT 1"}}),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call json");
        assert_eq!(called["result"]["content"][0]["text"], "ran: SELECT 1");
        assert_ne!(called["result"]["isError"], serde_json::json!(true));

        // a failed tool call is text for the model, not a JSON-RPC error
        let failed: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                4,
                "tools/call",
                serde_json::json!({"name": "describe_tables", "arguments": {"names": ["nope"]}}),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call json");
        assert!(failed["error"].is_null());
        assert_eq!(failed["result"]["isError"], serde_json::json!(true));
        assert!(failed["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|t| t.starts_with("ERROR: unknown table")));

        let ping: serde_json::Value =
            post(&endpoint, &endpoint.token, rpc(5, "ping", serde_json::json!({})))
                .await
                .json()
                .await
                .expect("ping json");
        assert!(ping["error"].is_null());

        // a notification has no id and earns no body
        let notified = post(
            &endpoint,
            &endpoint.token,
            serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;
        assert_eq!(notified.status(), 202);

        // `claude -p` opens with a `server/discover` preflight on the 2026-07-28
        // revision; the gate DECLINES it with method-not-found (id echoed, HTTP
        // 200) so the CLI falls back to `initialize` at 2025-11-25, the only
        // revision measured to deliver the tools to the model (see
        // decline_discover). Headers older revisions never defined still pass.
        let preflight = reqwest::Client::new()
            .post(&endpoint.url)
            .header("authorization", format!("Bearer {}", endpoint.token))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-method", "server/discover")
            .header("mcp-protocol-version", "2026-07-28")
            .json(&rpc(
                6,
                "server/discover",
                serde_json::json!({"_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {}
                }}),
            ))
            .send()
            .await
            .expect("preflight");
        assert_eq!(preflight.status(), 200);
        let declined: serde_json::Value = preflight.json().await.expect("discover json");
        assert_eq!(declined["id"], 6);
        assert_eq!(declined["error"]["code"], -32601);
        assert!(declined["result"].is_null());

        // the trace can say what the child reached for
        let log = agent_mcp_log(endpoint.token.clone()).await.expect("log");
        let names: Vec<&str> = log.iter().map(|c| c.tool.as_str()).collect();
        assert_eq!(names, ["run_sql", "describe_tables"]);
        assert!(!log[0].is_error);
        assert!(log[1].is_error);
        assert_eq!(log[0].bytes, "ran: SELECT 1".len() as u64);

        assert_eq!(session_for_token(&endpoint.token).as_deref(), Some("session-1"));
        agent_mcp_stop(endpoint.token.clone()).await.expect("stop");
        assert_eq!(session_for_token(&endpoint.token), None);
    }

    /// A canvas-targeted thread: the family is listed after the five and a
    /// call reaches the backend's one bridge method with the model's raw
    /// arguments. Nothing about the block is read on this side.
    #[tokio::test]
    async fn a_canvas_token_lists_the_family_and_routes_a_call_over_the_bridge() {
        let all = asked(&[
            "list_tables",
            "describe_tables",
            "peek_values",
            "run_sql",
            "probe",
            "canvas_write",
            "canvas_replace",
            "canvas_read",
        ]);
        let endpoint = endpoint_serving("session-canvas", Arc::new(FakeTools), Some(&all));

        post(&endpoint, &endpoint.token, rpc(1, "initialize", init_params())).await;
        let listed: serde_json::Value =
            post(&endpoint, &endpoint.token, rpc(2, "tools/list", serde_json::json!({})))
                .await
                .json()
                .await
                .expect("tools/list json");
        let names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect();
        let expected: Vec<String> = FIVE
            .iter()
            .copied()
            .chain(canvas_tools().iter().map(|t| t.name.as_ref()))
            .map(|n| n.to_string())
            .collect();
        assert_eq!(names, expected);

        let called: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                3,
                "tools/call",
                serde_json::json!({
                    "name": "canvas_write",
                    "arguments": {"blocks": [{"kind": "note", "text": "August held"}]}
                }),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call json");
        assert_ne!(called["result"]["isError"], serde_json::json!(true));
        assert_eq!(
            called["result"]["content"][0]["text"],
            "canvas_write {\"blocks\":[{\"kind\":\"note\",\"text\":\"August held\"}]}"
        );

        let log = agent_mcp_log(endpoint.token.clone()).await.expect("log");
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].tool, "canvas_write");
        agent_mcp_stop(endpoint.token.clone()).await.expect("stop");
    }

    /// A thread with no canvas target refuses a canvas call in the words this
    /// file has always refused an unknown tool with, listing the tools it
    /// actually serves. A model that never saw the tool cannot call it, and
    /// one that guesses is not taught that the tool exists.
    #[tokio::test]
    async fn a_token_with_no_canvas_list_refuses_a_canvas_call_in_todays_words() {
        let endpoint = endpoint_for("session-no-canvas", Arc::new(FakeTools));
        post(&endpoint, &endpoint.token, rpc(1, "initialize", init_params())).await;
        let called: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                2,
                "tools/call",
                serde_json::json!({"name": "canvas_write", "arguments": {"blocks": []}}),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call json");
        assert_eq!(called["result"]["isError"], serde_json::json!(true));
        assert_eq!(
            called["result"]["content"][0]["text"],
            "ERROR: unknown tool 'canvas_write'. Valid tools: list_tables, describe_tables, \
             peek_values, run_sql, probe"
        );
        agent_mcp_stop(endpoint.token.clone()).await.expect("stop");
    }

    #[tokio::test]
    async fn a_request_without_the_exact_token_is_401() {
        let endpoint = endpoint_for("session-2", Arc::new(FakeTools));

        let wrong = post(&endpoint, "not-the-token", rpc(1, "initialize", init_params())).await;
        assert_eq!(wrong.status(), 401);

        // a revoked token is as unknown as one that never existed
        let token = endpoint.token.clone();
        agent_mcp_stop(token.clone()).await.expect("stop");
        let revoked = post(&endpoint, &token, rpc(1, "initialize", init_params())).await;
        assert_eq!(revoked.status(), 401);
    }

    #[tokio::test]
    async fn a_foreign_origin_is_refused_before_the_token_is_read() {
        let endpoint = endpoint_for("session-3", Arc::new(FakeTools));
        let resp = reqwest::Client::new()
            .post(&endpoint.url)
            .header("authorization", format!("Bearer {}", endpoint.token))
            .header("origin", "http://evil.example")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(&rpc(1, "initialize", init_params()))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 403);
        agent_mcp_stop(endpoint.token).await.expect("stop");
    }

    /// End to end against the lab database: the MCP transport, the tool
    /// The real `claude -p` against this server, with the exact flags the app
    /// passes (claudecode.ts buildArgs): the only test that proves the model
    /// SEES the five tools. Needs the maintainer's subscription, so it is
    /// opt-in:  QWRY_TEST_CLAUDE=1 cargo test --lib -- --ignored claude_p_end
    #[tokio::test]
    #[ignore]
    async fn claude_p_end_to_end_lists_and_calls_the_tools() {
        if std::env::var("QWRY_TEST_CLAUDE").is_err() {
            eprintln!("QWRY_TEST_CLAUDE unset, skipping");
            return;
        }
        let endpoint = endpoint_for("e2e-session", Arc::new(FakeTools));
        let mcp_config = serde_json::json!({
            "mcpServers": { SERVER_NAME: {
                "type": "http", "url": endpoint.url,
                "headers": { "Authorization": format!("Bearer {}", endpoint.token) } } }
        })
        .to_string();
        let mut cmd = tokio::process::Command::new("claude");
        cmd.args([
            "-p", "--model", "claude-haiku-4-5", "--output-format", "stream-json", "--verbose",
            "--strict-mcp-config", "--mcp-config", &mcp_config, "--tools", "",
            "--allowedTools", &format!("mcp__{SERVER_NAME}__*"), "--setting-sources", "",
            "--max-turns", "4", "--system-prompt",
            "You have MCP tools. Call list_tables exactly once, then answer with the number of tables.",
        ])
        .env_clear()
        .envs(crate::agent_claude::child_env_for_tests())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("spawn claude");
        {
            use tokio::io::AsyncWriteExt;
            let mut stdin = child.stdin.take().expect("stdin");
            stdin.write_all(b"How many tables are there?").await.expect("write");
        }
        let out = tokio::time::timeout(std::time::Duration::from_secs(120), child.wait_with_output())
            .await
            .expect("claude finished within 120s")
            .expect("claude ran");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let mut init: Option<serde_json::Value> = None;
        let mut tool_uses: Vec<String> = Vec::new();
        for line in stdout.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v["type"] == "system" && v["subtype"] == "init" {
                init = Some(v.clone());
            }
            if v["type"] == "assistant" {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_use" {
                        tool_uses.push(b["name"].as_str().unwrap_or_default().to_string());
                    }
                }
            }
        }
        let init = init.unwrap_or_else(|| panic!("no system/init event; stderr: {stderr}"));
        eprintln!("init.mcp_servers = {}", init["mcp_servers"]);
        eprintln!("init.tools = {}", init["tools"]);
        let tools: Vec<&str> = init["tools"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(init["mcp_servers"][0]["status"], "connected", "server status");
        assert!(
            tools.iter().any(|t| *t == format!("mcp__{SERVER_NAME}__list_tables")),
            "the model must see the MCP tools; saw {tools:?}"
        );
        assert!(
            tool_uses.iter().any(|n| n.ends_with("list_tables")),
            "expected a list_tables tool_use, saw {tool_uses:?}; stderr: {stderr}"
        );
        let served = registry()
            .lock()
            .expect("registry")
            .tokens
            .get(&endpoint.token)
            .map(|t| t.log.lock().map(|l| l.len()).unwrap_or(0));
        eprintln!("mcp calls served = {served:?}");
    }

    /// dispatch and a real read-only query in one path. Run with
    ///   QWRY_TEST_HOST=127.0.0.1 QWRY_TEST_PORT=5455 QWRY_TEST_USER=lab \
    ///   QWRY_TEST_DB=pagila cargo test --lib -- --ignored mcp_over_the_lab
    #[tokio::test]
    #[ignore]
    async fn mcp_over_the_lab_database_runs_a_query() {
        use crate::driver::postgres;
        use crate::driver::Profile;

        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let profile = Profile {
            id: "lab".into(),
            name: "lab".into(),
            host: env("QWRY_TEST_HOST", "127.0.0.1"),
            port: env("QWRY_TEST_PORT", "5455").parse().unwrap_or(5455),
            dbname: env("QWRY_TEST_DB", "pagila"),
            user: env("QWRY_TEST_USER", "lab"),
            sslmode: "disable".into(),
            color: None,
            glyph: None,
            is_prod: false,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_key: None,
        };
        let session = postgres::connect(
            &profile,
            &env("QWRY_TEST_PASSWORD", ""),
            None,
            None,
            None,
            true,
            Box::new(|_, _| {}),
            Box::new(|_| {}),
        )
        .await
        .expect("connect to the lab database");

        /// `SessionBackend` resolves its session out of a Tauri `AppState`
        /// this test has no way to build, so the session is handed over
        /// directly. Everything below it is the real path: the AST gate, the
        /// read-only transaction and the same result text.
        struct LabTools(Arc<postgres::PgSession>);

        impl LabTools {
            async fn meta(&self) -> std::result::Result<Meta, String> {
                let (snap, _) =
                    self.0.introspect(Some(Vec::new())).await.map_err(tool_error)?;
                Ok(Meta::build(&snap))
            }
        }

        #[async_trait::async_trait]
        impl McpToolBackend for LabTools {
            async fn list_tables(&self) -> ToolText {
                Ok(list_tables_text(&self.meta().await?))
            }
            async fn describe_tables(&self, names: Vec<String>) -> ToolText {
                let meta = self.meta().await?;
                let mut picked: Vec<&TableMeta> = Vec::new();
                for raw in &names {
                    let Some(t) = meta.resolve(raw) else {
                        return Err(unknown_table(&meta, raw));
                    };
                    picked.push(t);
                }
                let refs: Vec<TableRef> = picked
                    .iter()
                    .map(|t| TableRef {
                        schema: t.schema.clone(),
                        name: t.name.clone(),
                    })
                    .collect();
                let stats = crate::agent::describe(&self.0, &refs).await.map_err(tool_error)?;
                Ok(describe_text(&meta, &picked, &stats))
            }
            async fn peek_values(&self, table: String, column: String, limit: u32) -> ToolText {
                let peek = crate::agent::peek_values(&self.0, "public", &table, &column, limit)
                    .await
                    .map_err(tool_error)?;
                Ok(peek_text(&peek.values, peek.more))
            }
            async fn run_sql(&self, sql: String) -> ToolText {
                let run = crate::agent::run_readonly(
                    &self.0,
                    &sql,
                    crate::agent::UI_ROW_CAP,
                    RUN_SQL_TIMEOUT_MS,
                )
                .await
                .map_err(tool_error)?;
                Ok(run_text(&run))
            }
            async fn probe(&self, sqls: Vec<String>) -> ToolText {
                let results = crate::agent::probe(&self.0, &sqls).await.map_err(tool_error)?;
                Ok(probe_text(&results))
            }
            /// no window on the other side of this one: the lab run drives the
            /// database, and the canvas is the app's
            async fn canvas_call(&self, _name: String, _args_json: String) -> ToolText {
                Err("ERROR: the canvas is closed. Say your findings here instead".into())
            }
        }

        let endpoint = endpoint_for("lab-session", Arc::new(LabTools(Arc::new(session))));
        let _: serde_json::Value = post(&endpoint, &endpoint.token, rpc(1, "initialize", init_params()))
            .await
            .json()
            .await
            .expect("initialize");
        let called: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                2,
                "tools/call",
                serde_json::json!({"name": "run_sql", "arguments": {"sql": "SELECT 1 AS one"}}),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call");
        assert_eq!(called["result"]["content"][0]["text"], "one\n1\n(1 rows)");

        // the gate refusal reaches the model as text it can repair from, not
        // as a JSON-RPC error and not as a successful empty result
        let refused: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                3,
                "tools/call",
                serde_json::json!({
                    "name": "run_sql",
                    "arguments": {"sql": "DELETE FROM actor"}
                }),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call");
        assert!(refused["error"].is_null());
        assert_eq!(refused["result"]["isError"], serde_json::json!(true));
        assert!(refused["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|t| t.starts_with("ERROR: ")));

        let listed: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(4, "tools/call", serde_json::json!({"name": "list_tables"})),
        )
        .await
        .json()
        .await
        .expect("tools/call");
        assert!(listed["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|t| t.contains("actor  (~")));

        let described: serde_json::Value = post(
            &endpoint,
            &endpoint.token,
            rpc(
                5,
                "tools/call",
                serde_json::json!({"name": "describe_tables", "arguments": {"names": ["film"]}}),
            ),
        )
        .await
        .json()
        .await
        .expect("tools/call");
        let ddl = described["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(ddl.starts_with("CREATE TABLE film (  -- ~"), "{ddl}");
        assert!(ddl.contains("film_id integer PRIMARY KEY"), "{ddl}");
        assert!(ddl.contains("REFERENCES language(language_id)"), "{ddl}");
        assert!(ddl.contains("  -- values: 'G', 'NC-17', 'PG', 'PG-13', 'R'"), "{ddl}");
        assert!(ddl.trim_end().ends_with(");"), "{ddl}");

        let log = agent_mcp_log(endpoint.token.clone()).await.expect("log");
        assert_eq!(
            log.iter().map(|c| c.tool.as_str()).collect::<Vec<_>>(),
            ["run_sql", "run_sql", "list_tables", "describe_tables"]
        );
        assert_eq!(
            log.iter().map(|c| c.is_error).collect::<Vec<_>>(),
            [false, true, false, false]
        );
        agent_mcp_stop(endpoint.token).await.expect("stop");
    }
}
