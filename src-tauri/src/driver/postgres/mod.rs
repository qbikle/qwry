use std::time::Instant;

use tokio_postgres::{Client, SimpleQueryMessage};

use super::{ColumnMeta, DriverError, ExecOutcome, Profile, Result, StatementResult};

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
}

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
/// network error) `on_close` fires. An intentional disconnect aborts this task
/// (PgSession::drop) before it reaches `on_close`, so it only signals a real
/// death — the frontend uses it to flip the connection's status dot.
fn spawn_session<S, T>(
    client: Client,
    mut connection: tokio_postgres::Connection<S, T>,
    tls: TlsChoice,
    on_notice: Box<dyn Fn(String, String) + Send>,
    on_close: Box<dyn FnOnce() + Send>,
) -> PgSession
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let cancel = client.cancel_token();
    let conn_handle = tokio::spawn(async move {
        loop {
            match futures_util::future::poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(tokio_postgres::AsyncMessage::Notice(db))) => {
                    on_notice(db.severity().to_string(), db.message().to_string());
                }
                Some(Ok(_)) => {} // LISTEN notifications etc. — not ours (yet)
                Some(Err(e)) => {
                    eprintln!("pg connection error: {e}");
                    break;
                }
                None => break, // clean close
            }
        }
        on_close();
    });
    PgSession {
        client,
        cancel,
        tls,
        conn_handle,
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
    on_close: Box<dyn FnOnce() + Send>,
) -> Result<PgSession> {
    let cfg = pg_config(profile, password, addr, statement_timeout_ms.unwrap_or(300_000));

    let try_tls = profile.sslmode != "disable";
    let try_plain = profile.sslmode != "require";

    if try_tls {
        match cfg.connect(tls::connector()).await {
            Ok((client, connection)) => {
                return Ok(spawn_session(client, connection, TlsChoice::Tls, on_notice, on_close));
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
    Ok(spawn_session(client, connection, TlsChoice::Plain, on_notice, on_close))
}

impl PgSession {
    pub fn is_tls(&self) -> bool {
        self.tls == TlsChoice::Tls
    }

    /// Execute one or more statements via the simple protocol.
    /// All values arrive as wire text — universal across every PG type, and
    /// multi-statement strings work natively. (P2 replaces this with streaming.)
    pub async fn execute_simple(&self, sql: &str) -> Result<ExecOutcome> {
        let start = Instant::now();
        let msgs = self
            .client
            .simple_query(sql)
            .await
            .map_err(map_pg_err)?;
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

    pub async fn cancel(&self) -> Result<()> {
        // the cancel request opens a NEW connection — through a dead tunnel it
        // would hang forever, so cancel itself gets a hard deadline
        let token = self.cancel.clone();
        let fut = async {
            match self.tls {
                TlsChoice::Plain => token.cancel_query(tokio_postgres::NoTls).await,
                TlsChoice::Tls => token.cancel_query(tls::connector()).await,
            }
        };
        match tokio::time::timeout(std::time::Duration::from_secs(3), fut).await {
            Ok(res) => res.map_err(|e| DriverError::Internal(format!("cancel failed: {e}"))),
            Err(_) => Err(DriverError::Internal(
                "cancel timed out — connection may be dead (disconnect to force)".into(),
            )),
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
