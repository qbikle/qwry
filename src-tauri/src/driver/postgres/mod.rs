use std::sync::atomic::{AtomicI32, AtomicU8, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tokio_postgres::{Client, SimpleQueryMessage};

use super::{ColumnMeta, DriverError, ExecOutcome, Profile, Result, StatementResult, TxState};

pub mod edit;
mod execute;
pub mod introspect;
mod splitter;
mod tls;

pub struct PgSession {
    client: Client,
    cancel: tokio_postgres::CancelToken,
    tls: TlsChoice,
    conn_handle: tokio::task::JoinHandle<()>,
    /// connect config kept so cancel escalation can open a FRESH connection
    /// with the same creds/address — cancel must never depend on the busy
    /// session's health
    cfg: tokio_postgres::Config,
    /// server backend pid, captured at connect (pg_backend_pid()); target of
    /// pg_cancel_backend / pg_terminate_backend escalation
    backend_pid: AtomicI32,
    /// backend_start (pg_stat_activity, wire text), captured with the pid —
    /// escalation matches BOTH so a recycled pid is never signaled
    backend_start: Mutex<String>,
    /// TxState as u8 — authoritative transaction status (see driver::TxState)
    tx: AtomicU8,
    /// count of statements currently executing on this session (a counter, not
    /// a flag: overlapping work must not false-clear completion detection)
    busy: AtomicUsize,
    /// fired on every tx-state CHANGE (frontend chip feed)
    on_tx: Mutex<Option<TxListener>>,
}

type TxListener = Box<dyn Fn(TxState) + Send + Sync>;

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
    // doubling quotes only. statement_timeout: user-tunable via Settings —
    // a dead tunnel or runaway query must never hang a session forever.
    // is_prod: SAFE MODE — the session starts read-only at the SERVER; a
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
    cfg.host(host)
        .port(port)
        .dbname(&profile.dbname)
        .user(&profile.user)
        .password(password)
        .application_name("qwry")
        .options(&opts)
        // dead-peer detection in ~60s instead of the kernel's 2h default —
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
/// reaches `on_close`, so it only signals a real death — the frontend uses it
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
    let conn_handle = tokio::spawn(async move {
        let reason = loop {
            match futures_util::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(tokio_postgres::AsyncMessage::Notice(db))) => {
                    on_notice(db.severity().to_string(), db.message().to_string());
                }
                Some(Ok(_)) => {} // LISTEN notifications etc. — not ours (yet)
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
        on_close(reason);
    });
    PgSession {
        client,
        cancel,
        tls,
        conn_handle,
        cfg,
        backend_pid: AtomicI32::new(0),
        backend_start: Mutex::new(String::new()),
        tx: AtomicU8::new(0),
        busy: AtomicUsize::new(0),
        on_tx: Mutex::new(None),
    }
}

/// Connect to a profile. When `addr` is given (an SSH tunnel's local endpoint),
/// it overrides the profile's host/port; dbname/user/sslmode still come from the
/// profile. TLS uses a no-verify verifier, so the tunnel hostname mismatch is fine.
/// `on_close` fires when the connection later dies (see `spawn_session`).
pub async fn connect(
    profile: &Profile,
    password: &str,
    addr: Option<(&str, u16)>,
    statement_timeout_ms: Option<u64>,
    on_notice: Box<dyn Fn(String, String) + Send>,
    on_close: Box<dyn FnOnce(Option<String>) + Send>,
) -> Result<PgSession> {
    let cfg = pg_config(profile, password, addr, statement_timeout_ms.unwrap_or(300_000));

    let try_tls = profile.sslmode != "disable";
    let try_plain = profile.sslmode != "require";

    let session = 'sess: {
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
                // reason — a plain retry would only mask it with a confusing
                // "no encryption"/SSL error, so surface the true cause now
                Err(e) if !try_plain || e.as_db_error().is_some() => {
                    return Err(connect_err(e));
                }
                Err(_) => {} // TLS negotiation/transport failure — fall through to plain
            }
        }

        let (client, connection) = cfg
            .connect(tokio_postgres::NoTls)
            .await
            .map_err(connect_err)?;
        spawn_session(client, connection, TlsChoice::Plain, cfg.clone(), on_notice, on_close)
    };

    // capture the backend identity now — cancel escalation targets it from a
    // fresh connection, so it must be known before any query can get stuck.
    // backend_start rides along: pid + start time together name THIS backend,
    // so a recycled pid can never be cancelled/terminated by mistake.
    let out = session
        .execute_simple(
            "SELECT pg_backend_pid(), backend_start FROM pg_stat_activity \
             WHERE pid = pg_backend_pid()",
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
    Ok(session)
}

/// RAII busy marker — cancel escalation polls it to see whether the query died
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
/// `WORK`/`TRANSACTION` filler (opt_transaction in the grammar) —
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

/// state after a statement ERRORED: inside an explicit tx PG aborts it —
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

    /// Execute one or more statements via the simple protocol.
    /// All values arrive as wire text — universal across every PG type, and
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
                // an already-open tx → FailedTx) — only edit batches flow
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

        // simple_query gives one round trip for the whole batch — per-statement
        // timing lands with the P2 streaming executor.
        let n = statements.len().max(1) as f64;
        for stmt in &mut statements {
            stmt.ms = total_ms / n;
        }

        Ok(ExecOutcome { statements })
    }

    /// protocol-level cancel via the CancelToken (opens a new connection —
    /// through a dead tunnel it would hang forever, hence the hard deadline)
    pub(crate) async fn token_cancel(&self) -> Result<()> {
        let token = self.cancel.clone();
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

    /// (pid, backend_start) captured at connect — out-of-band signals match
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

    /// pg_terminate_backend over a fresh connection — kills the server
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

    async fn run_on_fresh_connection(&self, sql: &str) -> Result<()> {
        let cfg = self.cfg.clone();
        let deadline = std::time::Duration::from_secs(5);
        let run = async {
            match self.tls {
                TlsChoice::Tls => {
                    let (client, conn) = cfg.connect(tls::connector()).await.map_err(connect_err)?;
                    let h = tokio::spawn(async move {
                        let _ = conn.await;
                    });
                    let res = client.simple_query(sql).await.map_err(map_pg_err);
                    h.abort();
                    res.map(|_| ())
                }
                TlsChoice::Plain => {
                    let (client, conn) =
                        cfg.connect(tokio_postgres::NoTls).await.map_err(connect_err)?;
                    let h = tokio::spawn(async move {
                        let _ = conn.await;
                    });
                    let res = client.simple_query(sql).await.map_err(map_pg_err);
                    h.abort();
                    res.map(|_| ())
                }
            }
        };
        match tokio::time::timeout(deadline, run).await {
            Ok(res) => res,
            Err(_) => Err(DriverError::Internal("timed out opening the control connection".into())),
        }
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
