use std::sync::atomic::{AtomicI32, AtomicI64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tokio_postgres::{Client, SimpleQueryMessage};

use super::{ColumnMeta, DriverError, ExecOutcome, Profile, Result, StatementResult, TxState};

pub mod edit;
mod execute;
pub mod introspect;
mod splitter;
pub mod stats;
mod tls;

pub struct PgSession {
    client: Client,
    cancel: tokio_postgres::CancelToken,
    tls: TlsChoice,
    conn_handle: tokio::task::JoinHandle<()>,
    /// connect config kept so cancel escalation can open a FRESH connection
    /// with the same creds/address; cancel must never depend on the busy
    /// session's health
    cfg: tokio_postgres::Config,
    /// control-lane config (SSH-tunneled sessions): same destination through
    /// a SECOND ssh process, so cancel's new connection can't queue behind
    /// data-lane row bytes (head-of-line blocking on one ssh TCP connection)
    control_cfg: Option<tokio_postgres::Config>,
    /// the control lane's raw address; token_cancel dials it directly
    /// (CancelToken::cancel_query would redial the stored data-lane socket)
    control_addr: Option<(String, u16)>,
    /// on_close callback, shared with the connection task: exactly one taker
    /// ever fires it, so a unilateral abort and a natural death cannot both
    /// report the session's end
    on_close: CloseNotifier,
    /// set once abort_connection ran; disconnect skips the cancel ladder
    /// for an already-dead connection instead of dialing for ~8s
    aborted: std::sync::atomic::AtomicBool,
    /// server backend pid, captured at connect (pg_backend_pid()); target of
    /// pg_cancel_backend / pg_terminate_backend escalation
    backend_pid: AtomicI32,
    /// backend_start (pg_stat_activity, wire text), captured with the pid;
    /// escalation matches BOTH so a recycled pid is never signaled
    backend_start: Mutex<String>,
    /// server_version_num captured at connect (0 = unknown); the frontend
    /// gates ctid keyset pagination on it (tid btree ops are PG 14+)
    server_version_num: AtomicI64,
    /// full server_version string; keys the appdb pg_catalog function cache
    /// (pg_catalog contents only change with the server build)
    server_version: Mutex<String>,
    /// TxState as u8: authoritative transaction status (see driver::TxState)
    tx: AtomicU8,
    /// count of statements currently executing on this session (a counter, not
    /// a flag: overlapping work must not false-clear completion detection)
    busy: AtomicUsize,
    /// fired on every tx-state CHANGE (frontend chip feed)
    on_tx: Mutex<Option<TxListener>>,
}

type TxListener = Box<dyn Fn(TxState) + Send + Sync>;
type CloseNotifier = std::sync::Arc<Mutex<Option<Box<dyn FnOnce(Option<String>) + Send>>>>;

#[derive(Clone, Copy, PartialEq)]
pub enum TlsChoice {
    Plain,
    Tls,
}

impl Drop for PgSession {
    fn drop(&mut self) {
        self.conn_handle.abort();
    }
}

fn pg_config(
    profile: &Profile,
    password: &str,
    addr: Option<(&str, u16)>,
    statement_timeout_ms: u64,
) -> tokio_postgres::Config {
    let (host, port) = addr.unwrap_or((profile.host.as_str(), profile.port));
    let mut cfg = tokio_postgres::Config::new();
    // standard_conforming_strings: generated edit SQL escapes literals by
    // doubling quotes only. statement_timeout: user-tunable via Settings;
    // a dead tunnel or runaway query must never hang a session forever.
    // is_prod: SAFE MODE. The session starts read-only at the SERVER; a
    // stray UPDATE on a prod-flagged connection errors before touching data
    // (per-tab unlock runs SET default_transaction_read_only = off).
    let mut opts = format!(
        "-c standard_conforming_strings=on \
         -c statement_timeout={statement_timeout_ms} \
         -c idle_in_transaction_session_timeout=600000"
    );
    if profile.is_prod {
        opts.push_str(" -c default_transaction_read_only=on");
    }
    // sslmode=require must actually REQUIRE: tokio-postgres defaults to
    // Prefer, which silently downgrades to plaintext when the server says N
    match profile.sslmode.as_str() {
        "require" => {
            cfg.ssl_mode(tokio_postgres::config::SslMode::Require);
        }
        "disable" => {
            cfg.ssl_mode(tokio_postgres::config::SslMode::Disable);
        }
        _ => {}
    }
    cfg.host(host)
        .port(port)
        .dbname(&profile.dbname)
        .user(&profile.user)
        .password(password)
        .application_name("qwry")
        .options(&opts)
        // dead-peer detection in ~60s instead of the kernel's 2h default:
        // the SSH-tunnel-drop case must fail fast, not spin forever
        .keepalives(true)
        .keepalives_idle(std::time::Duration::from_secs(30))
        .keepalives_interval(std::time::Duration::from_secs(10))
        .keepalives_retries(3)
        .connect_timeout(std::time::Duration::from_secs(10));
    cfg
}

/// turn a tokio-postgres connect error into a DriverError, preferring the
/// server's own message (e.g. `password authentication failed for user …`)
/// over the generic transport wrapper so the UI can show the real reason
fn connect_err(e: tokio_postgres::Error) -> DriverError {
    match e.as_db_error() {
        Some(db) => DriverError::Connect(db.message().to_string()),
        None => DriverError::Connect(e.to_string()),
    }
}

/// spawn the connection driver task, draining async messages so server-sent
/// NOTICEs (RAISE NOTICE, implicit-index notes, …) reach the UI instead of
/// being dropped on the floor. When the connection ends (server drop /
/// network error) `on_close` fires with the error text when there is one.
/// An intentional disconnect aborts this task (PgSession::drop) before it
/// reaches `on_close`, so it only signals a real death; the frontend uses it
/// to flip the connection's status dot.
fn spawn_session<S, T>(
    client: Client,
    mut connection: tokio_postgres::Connection<S, T>,
    tls: TlsChoice,
    cfg: tokio_postgres::Config,
    on_notice: Box<dyn Fn(String, String) + Send>,
    on_close: Box<dyn FnOnce(Option<String>) + Send>,
) -> PgSession
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let cancel = client.cancel_token();
    let notifier: CloseNotifier = std::sync::Arc::new(Mutex::new(Some(on_close)));
    let task_notifier = notifier.clone();
    let conn_handle = tokio::spawn(async move {
        let reason = loop {
            match futures_util::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(tokio_postgres::AsyncMessage::Notice(db))) => {
                    on_notice(db.severity().to_string(), db.message().to_string());
                }
                Some(Ok(_)) => {} // LISTEN notifications etc., not ours (yet)
                Some(Err(e)) => {
                    eprintln!("pg connection error: {e}");
                    break Some(match e.as_db_error() {
                        Some(db) => db.message().to_string(),
                        None => e.to_string(),
                    });
                }
                None => break Some("connection closed by server".into()),
            }
        };
        if let Some(f) = task_notifier.lock().ok().and_then(|mut slot| slot.take()) {
            f(reason);
        }
    });
    PgSession {
        client,
        cancel,
        tls,
        conn_handle,
        cfg,
        control_cfg: None,
        control_addr: None,
        on_close: notifier,
        aborted: std::sync::atomic::AtomicBool::new(false),
        backend_pid: AtomicI32::new(0),
        backend_start: Mutex::new(String::new()),
        server_version_num: AtomicI64::new(0),
        server_version: Mutex::new(String::new()),
        tx: AtomicU8::new(0),
        busy: AtomicUsize::new(0),
        on_tx: Mutex::new(None),
    }
}

/// Connect to a profile. When `addr` is given (an SSH tunnel's local endpoint),
/// it overrides the profile's host/port; dbname/user/sslmode still come from the
/// profile. TLS uses a no-verify verifier, so the tunnel hostname mismatch is fine.
/// `control_addr` is the tunnel's control-lane endpoint (a second ssh process):
/// when given, cancel/terminate signals dial it instead of the congestible data
/// lane. `on_close` fires when the connection later dies (see `spawn_session`).
pub async fn connect(
    profile: &Profile,
    password: &str,
    addr: Option<(&str, u16)>,
    control_addr: Option<(&str, u16)>,
    statement_timeout_ms: Option<u64>,
    on_notice: Box<dyn Fn(String, String) + Send>,
    on_close: Box<dyn FnOnce(Option<String>) + Send>,
) -> Result<PgSession> {
    let timeout_ms = statement_timeout_ms.unwrap_or(300_000);
    let cfg = pg_config(profile, password, addr, timeout_ms);

    let try_tls = profile.sslmode != "disable";
    let try_plain = profile.sslmode != "require";

    let mut session = 'sess: {
        if try_tls {
            match cfg.connect(tls::connector()).await {
                Ok((client, connection)) => {
                    break 'sess spawn_session(
                        client,
                        connection,
                        TlsChoice::Tls,
                        cfg.clone(),
                        on_notice,
                        on_close,
                    );
                }
                // a server-sent error (bad password, pg_hba, missing db…) is the real
                // reason; a plain retry would only mask it with a confusing
                // "no encryption"/SSL error, so surface the true cause now
                Err(e) if !try_plain || e.as_db_error().is_some() => {
                    return Err(connect_err(e));
                }
                Err(_) => {} // TLS negotiation/transport failure: fall through to plain
            }
        }

        let (client, connection) = cfg
            .connect(tokio_postgres::NoTls)
            .await
            .map_err(connect_err)?;
        spawn_session(client, connection, TlsChoice::Plain, cfg.clone(), on_notice, on_close)
    };
    if let Some((host, port)) = control_addr {
        session.control_cfg = Some(pg_config(profile, password, Some((host, port)), timeout_ms));
        session.control_addr = Some((host.to_string(), port));
    }

    // capture the backend identity now: cancel escalation targets it from a
    // fresh connection, so it must be known before any query can get stuck.
    // backend_start rides along: pid + start time together name THIS backend,
    // so a recycled pid can never be cancelled/terminated by mistake.
    let out = session
        .execute_simple(
            "SELECT pg_backend_pid(), backend_start, \
                    current_setting('server_version_num'), \
                    current_setting('server_version') \
             FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        )
        .await?;
    let row = out.statements.first().and_then(|s| s.rows.first());
    let pid: i32 = row
        .and_then(|r| r.first().cloned().flatten())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| DriverError::Connect("could not read backend pid".into()))?;
    let start = row
        .and_then(|r| r.get(1).cloned().flatten())
        .ok_or_else(|| DriverError::Connect("could not read backend start time".into()))?;
    session.backend_pid.store(pid, Ordering::Relaxed);
    if let Ok(mut s) = session.backend_start.lock() {
        *s = start;
    }
    // best-effort: 0/"" means unknown and only disables version-gated paths
    let vnum: i64 = row
        .and_then(|r| r.get(2).cloned().flatten())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    session.server_version_num.store(vnum, Ordering::Relaxed);
    if let (Some(v), Ok(mut s)) = (
        row.and_then(|r| r.get(3).cloned().flatten()),
        session.server_version.lock(),
    ) {
        *s = v;
    }
    Ok(session)
}

/// RAII busy marker: cancel escalation polls it to see whether the query died
struct BusyGuard<'a>(&'a AtomicUsize);
impl<'a> BusyGuard<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        BusyGuard(counter)
    }
}
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Tx-control head: the verb plus the two tokens after PG's optional
/// `WORK`/`TRANSACTION` filler (opt_transaction in the grammar):
/// `ROLLBACK WORK TO SAVEPOINT sp` and `ROLLBACK TO SAVEPOINT sp` must read
/// the same. The filler is only skipped after COMMIT/END/ROLLBACK/ABORT
/// (`PREPARE TRANSACTION` needs its literal second token).
fn tx_head(sql: &str) -> (String, String, String) {
    let toks = splitter::statement_tokens(sql, 4);
    let tok = |i: usize| toks.get(i).cloned().unwrap_or_default();
    let first = tok(0);
    let base = if matches!(first.as_str(), "commit" | "end" | "rollback" | "abort")
        && matches!(tok(1).as_str(), "work" | "transaction")
    {
        2
    } else {
        1
    };
    (first, tok(base), tok(base + 1))
}

/// fold one completed statement's head into the transaction state
fn fold_tx(state: TxState, sql: &str) -> TxState {
    let (first, second, third) = tx_head(sql);
    match first.as_str() {
        "begin" | "start" => TxState::InTx,
        // COMMIT/END in a failed tx acts as rollback; AND CHAIN opens the next
        // (AND NO CHAIN does not)
        "commit" | "end" => {
            if second == "and" && third == "chain" {
                TxState::InTx
            } else {
                TxState::Idle
            }
        }
        "rollback" | "abort" => {
            if second == "to" {
                // ROLLBACK TO SAVEPOINT keeps the tx open and un-fails it
                TxState::InTx
            } else if second == "and" && third == "chain" {
                TxState::InTx
            } else {
                TxState::Idle
            }
        }
        // two-phase commit dissociates the tx from the session
        "prepare" if second == "transaction" => TxState::Idle,
        _ => state,
    }
}

/// state after a statement ERRORED: inside an explicit tx PG aborts it,
/// except a failed COMMIT/END (deferred constraint fired at commit time),
/// which still ends the tx: the server rolls back and returns to idle.
/// AND CHAIN keeps the conservative fold (the chained tx state is murky).
fn error_fold(state: TxState, sql: &str) -> TxState {
    if state == TxState::Idle {
        return TxState::Idle;
    }
    let (first, second, third) = tx_head(sql);
    if matches!(first.as_str(), "commit" | "end") && !(second == "and" && third == "chain") {
        TxState::Idle
    } else {
        TxState::FailedTx
    }
}

impl PgSession {
    pub fn is_tls(&self) -> bool {
        self.tls == TlsChoice::Tls
    }

    pub fn backend_pid(&self) -> i32 {
        self.backend_pid.load(Ordering::Relaxed)
    }

    /// server_version_num captured at connect; 0 = unknown
    pub fn server_version_num(&self) -> i64 {
        self.server_version_num.load(Ordering::Relaxed)
    }

    /// full server_version string captured at connect; "" = unknown
    pub fn server_version(&self) -> String {
        self.server_version
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub fn tx_state(&self) -> TxState {
        match self.tx.load(Ordering::Relaxed) {
            1 => TxState::InTx,
            2 => TxState::FailedTx,
            _ => TxState::Idle,
        }
    }

    pub fn set_tx_listener(&self, f: TxListener) {
        if let Ok(mut slot) = self.on_tx.lock() {
            *slot = Some(f);
        }
    }

    pub(crate) fn set_tx_state(&self, next: TxState) {
        let raw = match next {
            TxState::Idle => 0u8,
            TxState::InTx => 1,
            TxState::FailedTx => 2,
        };
        let prev = self.tx.swap(raw, Ordering::Relaxed);
        if prev != raw {
            if let Ok(slot) = self.on_tx.lock() {
                if let Some(f) = slot.as_ref() {
                    f(next);
                }
            }
        }
    }

    /// a statement errored on this session: inside an explicit tx PG aborts
    /// the tx; outside, the implicit tx dies with the statement (still idle);
    /// a failed COMMIT/END without AND CHAIN ends the tx (see `error_fold`)
    pub(crate) fn note_error_outcome(&self, sql: &str) {
        self.set_tx_state(error_fold(self.tx_state(), sql));
    }

    /// fold a successfully executed statement's head into the tracked state
    pub(crate) fn fold_tx_head(&self, sql: &str) {
        self.set_tx_state(fold_tx(self.tx_state(), sql));
    }

    fn busy(&self) -> bool {
        self.busy.load(Ordering::Relaxed) > 0
    }

    /// Liveness probe for the frontend heal loop. A BUSY session is alive by
    /// definition: a probe would queue behind the running statement (simple
    /// protocol serializes) and lie by timeout. Idle: one EMPTY simple-query
    /// round trip — no parse, no tx side effects, and legal inside an aborted
    /// transaction (`SELECT 1` is not: it would report a merely-failed tx as
    /// dead and get a live session torn down).
    pub async fn probe(&self) -> bool {
        if self.busy() {
            return true;
        }
        matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                self.client.batch_execute(""),
            )
            .await,
            Ok(Ok(()))
        )
    }

    /// Execute one or more statements via the simple protocol.
    /// All values arrive as wire text: universal across every PG type, and
    /// multi-statement strings work natively. (P2 replaces this with streaming.)
    pub async fn execute_simple(&self, sql: &str) -> Result<ExecOutcome> {
        let start = Instant::now();
        let msgs = {
            let _busy = BusyGuard::new(&self.busy);
            self.client.simple_query(sql).await
        };
        let msgs = match msgs {
            Ok(m) => m,
            Err(e) => {
                // A failed message: DML since the last COMMIT rolls back, but
                // tx-control heads BEFORE the failing statement did execute
                // (a BEGIN opened the tx, a COMMIT already committed). The
                // server's error position (chars into the whole message)
                // locates the failing statement when present; fold the heads
                // before it, then apply the per-statement error outcome. A
                // multi-statement error WITHOUT a position falls back to the
                // position-blind conservative classifier (any BEGIN head, or
                // an already-open tx → FailedTx); only edit batches flow
                // through here today, and those never put tx control after
                // the wrapper, so the fallback cannot mis-fold them.
                let spans = splitter::split_statement_spans(sql);
                let pos = e.as_db_error().and_then(|db| match db.position() {
                    Some(tokio_postgres::error::ErrorPosition::Original(p)) => {
                        Some(*p as usize)
                    }
                    _ => None,
                });
                match (spans.len(), pos) {
                    (1, _) => self.note_error_outcome(&spans[0].sql),
                    (n, Some(p)) if n > 1 => {
                        let failing =
                            spans.iter().rposition(|s| s.char_offset < p).unwrap_or(0);
                        for s in &spans[..failing] {
                            self.fold_tx_head(&s.sql);
                        }
                        self.note_error_outcome(&spans[failing].sql);
                    }
                    _ => {
                        let heads_open_tx = spans.iter().any(|s| {
                            matches!(
                                splitter::statement_head(&s.sql).0.as_str(),
                                "begin" | "start"
                            )
                        });
                        if self.tx_state() != TxState::Idle || heads_open_tx {
                            self.set_tx_state(TxState::FailedTx);
                        }
                    }
                }
                return Err(map_pg_err(e));
            }
        };
        for stmt in splitter::split_statements(sql) {
            self.fold_tx_head(&stmt);
        }
        let total_ms = start.elapsed().as_secs_f64() * 1000.0;

        let mut statements: Vec<StatementResult> = Vec::new();
        let mut current: Option<StatementResult> = None;
        let mut index: u32 = 0;

        for msg in msgs {
            match msg {
                SimpleQueryMessage::RowDescription(cols) => {
                    if let Some(stmt) = current.take() {
                        statements.push(stmt);
                    }
                    current = Some(StatementResult {
                        index,
                        sql: String::new(),
                        columns: cols
                            .iter()
                            .map(|c| ColumnMeta {
                                name: c.name().to_string(),
                                type_oid: 0,
                                table_oid: 0,
                                attnum: 0,
                            })
                            .collect(),
                        rows: Vec::new(),
                        affected: None,
                        ms: 0.0,
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    if let Some(stmt) = current.as_mut() {
                        stmt.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(String::from))
                                .collect(),
                        );
                    }
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    let mut stmt = current.take().unwrap_or(StatementResult {
                        index,
                        sql: String::new(),
                        columns: Vec::new(),
                        rows: Vec::new(),
                        affected: None,
                        ms: 0.0,
                    });
                    stmt.affected = Some(n);
                    statements.push(stmt);
                    index += 1;
                }
                _ => {}
            }
        }
        if let Some(stmt) = current.take() {
            statements.push(stmt);
        }

        // simple_query gives one round trip for the whole batch; per-statement
        // timing lands with the P2 streaming executor.
        let n = statements.len().max(1) as f64;
        for stmt in &mut statements {
            stmt.ms = total_ms / n;
        }

        Ok(ExecOutcome { statements })
    }

    /// protocol-level cancel via the CancelToken (opens a new connection;
    /// through a dead tunnel it would hang forever, hence the hard deadline).
    /// Tunneled sessions dial the CONTROL lane themselves and hand the stream
    /// to `cancel_query_raw`; `cancel_query` would redial the stored
    /// data-lane address, whose handshake queues behind buffered row bytes
    /// when a bulk result saturates the tunnel.
    pub(crate) async fn token_cancel(&self) -> Result<()> {
        let token = self.cancel.clone();
        // control lane first, on its OWN short budget: a half-dead lane
        // (local listener still accepts, remote channel gone) must fail over
        // to the data lane instead of eating the whole deadline or committing
        // to an EPIPE once the local dial succeeded
        if let Some((host, port)) = self.control_addr.clone() {
            let attempt = async {
                let stream = tokio::net::TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|_| ())?;
                match self.tls {
                    TlsChoice::Plain => token
                        .cancel_query_raw(stream, tokio_postgres::NoTls)
                        .await
                        .map_err(|_| ()),
                    TlsChoice::Tls => {
                        use tokio_postgres::tls::MakeTlsConnect;
                        let mut mk = tls::connector();
                        let connector = match MakeTlsConnect::<
                            tokio::net::TcpStream,
                        >::make_tls_connect(&mut mk, &host)
                        {
                            Ok(c) => c,
                            Err(e) => match e {}, // Infallible
                        };
                        token.cancel_query_raw(stream, connector).await.map_err(|_| ())
                    }
                }
            };
            if let Ok(Ok(())) =
                tokio::time::timeout(std::time::Duration::from_millis(700), attempt).await
            {
                return Ok(());
            }
        }
        let fut = async {
            match self.tls {
                TlsChoice::Plain => token.cancel_query(tokio_postgres::NoTls).await,
                TlsChoice::Tls => token.cancel_query(tls::connector()).await,
            }
        };
        match tokio::time::timeout(std::time::Duration::from_millis(1500), fut).await {
            Ok(res) => res.map_err(|e| DriverError::Internal(format!("cancel failed: {e}"))),
            Err(_) => Err(DriverError::Internal("cancel timed out".into())),
        }
    }

    /// Escalating cancel: fire the protocol CancelToken, then poll whether the
    /// query actually died; if it hasn't within ~1.2s, open a FRESH connection
    /// with the same creds and pg_cancel_backend(pid). Cancel never shares the
    /// busy session's fate.
    pub async fn cancel(&self) -> Result<()> {
        let token_res = self.token_cancel().await;

        for _ in 0..12 {
            if !self.busy() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        match self.cancel_out_of_band().await {
            Ok(()) => Ok(()),
            Err(e) => {
                let token_note = match token_res {
                    Ok(()) => String::new(),
                    Err(te) => format!(" (protocol cancel: {te})"),
                };
                Err(DriverError::Internal(format!("{e}{token_note}")))
            }
        }
    }

    /// (pid, backend_start) captured at connect; out-of-band signals match
    /// BOTH via pg_stat_activity so a recycled pid is never signaled
    fn backend_identity(&self) -> Option<(i32, String)> {
        let pid = self.backend_pid();
        if pid == 0 {
            return None;
        }
        let start = self.backend_start.lock().ok()?.clone();
        if start.is_empty() {
            return None;
        }
        Some((pid, start))
    }

    fn backend_signal_sql(&self, func: &str) -> Option<String> {
        let (pid, start) = self.backend_identity()?;
        Some(format!(
            "SELECT {func}(pid) FROM pg_stat_activity \
             WHERE pid = {pid} AND backend_start = '{}'",
            start.replace('\'', "''")
        ))
    }

    /// pg_cancel_backend over a fresh short-lived connection
    pub async fn cancel_out_of_band(&self) -> Result<()> {
        let sql = self.backend_signal_sql("pg_cancel_backend").ok_or_else(|| {
            DriverError::Internal("backend identity unknown — cannot escalate cancel".into())
        })?;
        self.run_on_fresh_connection(&sql)
            .await
            .map_err(|e| DriverError::Internal(format!("out-of-band cancel failed: {e}")))
    }

    /// pg_terminate_backend over a fresh connection: kills the server
    /// process outright. Never called automatically; the UI offers it as the
    /// last tier behind an explicit confirm.
    pub async fn terminate_backend(&self) -> Result<()> {
        let sql = self.backend_signal_sql("pg_terminate_backend").ok_or_else(|| {
            DriverError::Internal("backend identity unknown — cannot terminate".into())
        })?;
        self.run_on_fresh_connection(&sql)
            .await
            .map_err(|e| DriverError::Internal(format!("terminate failed: {e}")))
    }

    /// Runs a control statement on a one-shot connection. Tunneled sessions
    /// go through the CONTROL lane (its own ssh process; a saturated data
    /// lane can't starve the handshake); if the control lane itself is
    /// unreachable, fall back to the data lane rather than not signaling.
    async fn run_on_fresh_connection(&self, sql: &str) -> Result<()> {
        // the control attempt gets its OWN sub-deadline: a half-dead lane
        // (local listener accepts, remote forward black-holed) must not eat
        // the whole budget and starve the data-lane retry
        if let Some(ctrl) = &self.control_cfg {
            match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                signal_over(ctrl, self.tls, sql),
            )
            .await
            {
                Ok(Ok(())) => return Ok(()),
                // transport-level connect failure or sub-timeout: the lane is
                // dead: retry on the data lane. A server-sent refusal or a
                // query error would only repeat there, so those return.
                Ok(Err((true, _))) | Err(_) => {}
                Ok(Err((false, e))) => return Err(e),
            }
        }
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            signal_over(&self.cfg, self.tls, sql),
        )
        .await
        {
            Ok(res) => res.map_err(|(_, e)| e),
            Err(_) => Err(DriverError::Internal("timed out opening the control connection".into())),
        }
    }

    /// Hard client-side kill: abort the connection driver task, so every
    /// in-flight query on this session errors out NOW ("connection closed")
    /// instead of draining the wire to completion. Silent: on_close is
    /// disarmed first (the disconnect path already removed the session and
    /// must not emit a death event for it).
    pub fn abort_connection(&self) {
        self.aborted.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut slot) = self.on_close.lock() {
            slot.take();
        }
        self.conn_handle.abort();
    }

    /// true once the connection was unilaterally killed; cancel ladders
    /// against it are pointless dialing
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// `abort_connection`, but fire on_close (frontend `session-closed`)
    /// first: for unilateral kills (terminate tier, row-cap abort) where
    /// the UI must learn the session is gone so it can flip the status dot
    /// and rebuild lazily. The shared notifier guarantees a racing natural
    /// death and this abort report at most once between them.
    pub fn abort_connection_notify(&self, reason: &str) {
        self.aborted.store(true, std::sync::atomic::Ordering::Relaxed);
        let cb = self.on_close.lock().ok().and_then(|mut slot| slot.take());
        self.conn_handle.abort();
        if let Some(f) = cb {
            f(Some(reason.to_string()));
        }
    }
}

/// one-shot signal connection for the cancel/terminate escalation. The bool
/// in the error is true when the CONNECTION failed at the transport level
/// (lane unreachable / timed out): the caller may retry on another lane;
/// false means the server answered (auth refusal, query error) and a retry
/// elsewhere would only repeat it.
async fn signal_over(
    cfg: &tokio_postgres::Config,
    tls_choice: TlsChoice,
    sql: &str,
) -> std::result::Result<(), (bool, DriverError)> {
    match tls_choice {
        TlsChoice::Tls => match cfg.connect(tls::connector()).await {
            Ok((client, conn)) => {
                let h = tokio::spawn(async move {
                    let _ = conn.await;
                });
                let res = client
                    .simple_query(sql)
                    .await
                    .map_err(|e| (false, map_pg_err(e)));
                h.abort();
                res.map(|_| ())
            }
            Err(e) => Err((e.as_db_error().is_none(), connect_err(e))),
        },
        TlsChoice::Plain => match cfg.connect(tokio_postgres::NoTls).await {
            Ok((client, conn)) => {
                let h = tokio::spawn(async move {
                    let _ = conn.await;
                });
                let res = client
                    .simple_query(sql)
                    .await
                    .map_err(|e| (false, map_pg_err(e)));
                h.abort();
                res.map(|_| ())
            }
            Err(e) => Err((e.as_db_error().is_none(), connect_err(e))),
        },
    }
}

fn map_pg_err(e: tokio_postgres::Error) -> DriverError {
    if let Some(db) = e.as_db_error() {
        let position = match db.position() {
            Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
            _ => None,
        };
        DriverError::Db {
            message: db.message().to_string(),
            position,
            code: Some(db.code().code().to_string()),
            detail: db.detail().map(str::to_string),
            hint: db.hint().map(str::to_string),
        }
    } else {
        DriverError::Db {
            message: e.to_string(),
            position: None,
            code: None,
            detail: None,
            hint: None,
        }
    }
}

#[cfg(test)]
mod tx_tests {
    use super::{error_fold, fold_tx};
    use crate::driver::TxState::*;

    #[test]
    fn fold_transitions() {
        assert_eq!(fold_tx(Idle, "BEGIN"), InTx);
        assert_eq!(fold_tx(Idle, "start transaction"), InTx);
        assert_eq!(fold_tx(InTx, "SELECT 1"), InTx);
        assert_eq!(fold_tx(InTx, "COMMIT"), Idle);
        assert_eq!(fold_tx(InTx, "END"), Idle);
        assert_eq!(fold_tx(FailedTx, "ROLLBACK"), Idle);
        assert_eq!(fold_tx(FailedTx, "commit"), Idle); // acts as rollback
        assert_eq!(fold_tx(FailedTx, "ROLLBACK TO SAVEPOINT s"), InTx);
        assert_eq!(fold_tx(InTx, "ROLLBACK TO s"), InTx);
        assert_eq!(fold_tx(InTx, "COMMIT AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "ROLLBACK AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "ABORT"), Idle);
        assert_eq!(fold_tx(Idle, "SELECT 1"), Idle);
        assert_eq!(fold_tx(InTx, "SAVEPOINT s"), InTx);
        assert_eq!(fold_tx(InTx, "RELEASE SAVEPOINT s"), InTx);
        assert_eq!(fold_tx(Idle, "-- c\n begin work"), InTx);
        assert_eq!(fold_tx(InTx, "PREPARE TRANSACTION 'gx'"), Idle);
        assert_eq!(fold_tx(InTx, "PREPARE p AS SELECT 1"), InTx);
    }

    #[test]
    fn fold_opt_transaction_filler() {
        // WORK/TRANSACTION filler must not hide the decisive token
        assert_eq!(fold_tx(InTx, "ROLLBACK WORK TO SAVEPOINT sp"), InTx);
        assert_eq!(fold_tx(FailedTx, "ROLLBACK TRANSACTION TO sp"), InTx);
        assert_eq!(fold_tx(InTx, "COMMIT WORK AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "COMMIT TRANSACTION AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "END TRANSACTION AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "END WORK AND CHAIN"), InTx);
        assert_eq!(fold_tx(InTx, "ROLLBACK WORK AND CHAIN"), InTx);
        // …and plain filler forms still end the tx
        assert_eq!(fold_tx(InTx, "COMMIT WORK"), Idle);
        assert_eq!(fold_tx(InTx, "COMMIT TRANSACTION"), Idle);
        assert_eq!(fold_tx(InTx, "END WORK"), Idle);
        assert_eq!(fold_tx(InTx, "ROLLBACK WORK"), Idle);
        assert_eq!(fold_tx(InTx, "ROLLBACK TRANSACTION"), Idle);
        assert_eq!(fold_tx(InTx, "ABORT TRANSACTION"), Idle);
        // AND NO CHAIN ends the tx (only AND CHAIN keeps it open)
        assert_eq!(fold_tx(InTx, "COMMIT AND NO CHAIN"), Idle);
        assert_eq!(fold_tx(InTx, "COMMIT WORK AND NO CHAIN"), Idle);
        assert_eq!(fold_tx(InTx, "END TRANSACTION AND NO CHAIN"), Idle);
        assert_eq!(fold_tx(InTx, "ROLLBACK AND NO CHAIN"), Idle);
        assert_eq!(fold_tx(FailedTx, "ROLLBACK WORK AND NO CHAIN"), Idle);
    }

    #[test]
    fn error_outcomes() {
        // errors outside a tx leave it idle
        assert_eq!(error_fold(Idle, "SELECT boom"), Idle);
        assert_eq!(error_fold(Idle, "COMMIT"), Idle);
        // errors inside a tx abort it…
        assert_eq!(error_fold(InTx, "SELECT boom"), FailedTx);
        assert_eq!(error_fold(FailedTx, "SELECT boom"), FailedTx);
        // …except a failed COMMIT/END, which the server resolves to idle
        assert_eq!(error_fold(InTx, "COMMIT"), Idle);
        assert_eq!(error_fold(InTx, "commit work"), Idle);
        assert_eq!(error_fold(InTx, "END"), Idle);
        assert_eq!(error_fold(InTx, "END TRANSACTION"), Idle);
        assert_eq!(error_fold(InTx, "COMMIT AND NO CHAIN"), Idle);
        // AND CHAIN keeps the conservative fold
        assert_eq!(error_fold(InTx, "COMMIT AND CHAIN"), FailedTx);
        assert_eq!(error_fold(InTx, "COMMIT WORK AND CHAIN"), FailedTx);
    }
}
