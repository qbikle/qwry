//! Streaming execution over the PG simple protocol — one statement at a time.
//!
//! Each split statement runs as its own `simple_query` (psql autocommit
//! semantics). This is a correctness keystone: with the whole buffer sent as
//! one query, PG wraps everything in ONE implicit transaction, so the UI would
//! report early UPDATEs as committed and then a later error silently rolled
//! them all back. Statement-at-a-time means what the UI reports as done really
//! is done, explicit BEGIN/COMMIT in the buffer still work (same connection),
//! a mid-script error stops the run at the failing statement, and statements
//! that refuse transaction blocks (VACUUM, CREATE INDEX CONCURRENTLY,
//! CREATE DATABASE) work in multi-statement buffers.
//!
//! Rows are batched and emitted through the caller-provided sink as they
//! arrive — no full materialization on the Rust side.

use std::time::Instant;

use futures_util::StreamExt;
use tokio_postgres::SimpleQueryMessage;

use super::splitter::split_statement_spans;
use super::{map_pg_err, PgSession};
use crate::driver::{
    ColumnMeta, DriverError, QueryEvent, Result, CELL_CAP, ROW_BATCH, ROW_CAP,
};

/// per-result-set row buffer
struct RowState {
    batch: Vec<Vec<Option<String>>>,
    truncated: Vec<(u32, u32)>,
    row_count: u64,
}

impl PgSession {
    /// Emits QueryEvent through `sink`; a `false` return from the sink means the
    /// receiver hung up — we stop emitting but keep draining the wire.
    pub async fn execute_stream(
        &self,
        sql: &str,
        sink: &mut (dyn FnMut(QueryEvent) -> bool + Send),
    ) -> Result<()> {
        let spans = split_statement_spans(sql);
        let total_start = Instant::now();

        let mut alive = true;
        let mut emit = |ev: QueryEvent, alive: &mut bool| {
            if *alive && !sink(ev) {
                *alive = false;
            }
        };

        // set when WE fired a cancel to stop a pointless drain (row cap hit on
        // the final statement, or the receiver hung up) — the resulting 57014
        // is then a successful completion, not an error
        let mut auto_cancelled = false;

        for (i, span) in spans.iter().enumerate() {
            let index = i as u32;
            let last_statement = i == spans.len() - 1;
            // auto-cancel is only safe for read-only statements: cancelling a
            // capped UPDATE/DELETE/INSERT…RETURNING rolls the WHOLE statement
            // back while the UI would report the rows as written
            let cancellable = {
                let head = span
                    .sql
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                matches!(head.as_str(), "select" | "table" | "values" | "show" | "explain")
            };
            // true start — progress and ms are real for DDL/UPDATE too (they
            // previously "started" only at completion)
            emit(
                QueryEvent::StatementStart { index, sql: span.sql.clone() },
                &mut alive,
            );
            let started = Instant::now();

            // PG reports a 1-based CHAR position within the statement it was
            // sent; rebase onto the whole executed buffer so the editor
            // squiggle lands right for statement index > 0
            let rebase = |e: tokio_postgres::Error| -> DriverError {
                let mut mapped = map_pg_err(e);
                if let DriverError::Db { position: Some(p), .. } = &mut mapped {
                    *p += span.char_offset as u32;
                }
                mapped
            };

            let stream = match self.client.simple_query_raw(&span.sql).await {
                Ok(s) => s,
                Err(e) => {
                    let mapped = rebase(e);
                    if let DriverError::Db { message, position, code, detail, hint } = &mapped {
                        emit(
                            QueryEvent::Error {
                                index,
                                message: message.clone(),
                                position: *position,
                                code: code.clone(),
                                detail: detail.clone(),
                                hint: hint.clone(),
                            },
                            &mut alive,
                        );
                    }
                    return Err(mapped);
                }
            };
            futures_util::pin_mut!(stream);

            let mut st: Option<RowState> = None;
            while let Some(msg) = stream.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        let mapped = rebase(e);
                        // our own drain-stopping cancel: finish the statement
                        // as capped instead of surfacing a phantom error
                        if auto_cancelled
                            && matches!(&mapped, DriverError::Db { code: Some(c), .. } if c == "57014")
                        {
                            if let Some(mut state) = st.take() {
                                if !state.batch.is_empty() {
                                    emit(
                                        QueryEvent::Rows {
                                            index,
                                            rows: std::mem::take(&mut state.batch),
                                            truncated: std::mem::take(&mut state.truncated),
                                        },
                                        &mut alive,
                                    );
                                }
                                emit(
                                    QueryEvent::StatementDone {
                                        index,
                                        affected: Some(state.row_count.min(ROW_CAP)),
                                        ms: started.elapsed().as_secs_f64() * 1000.0,
                                        row_count: state.row_count,
                                        capped: true,
                                    },
                                    &mut alive,
                                );
                            }
                            emit(
                                QueryEvent::Finished {
                                    total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
                                },
                                &mut alive,
                            );
                            return Ok(());
                        }
                        // stop at the failing statement; earlier statements
                        // have already truly committed (autocommit)
                        if let DriverError::Db { message, position, code, detail, hint } = &mapped {
                            emit(
                                QueryEvent::Error {
                                    index,
                                    message: message.clone(),
                                    position: *position,
                                    code: code.clone(),
                                    detail: detail.clone(),
                                    hint: hint.clone(),
                                },
                                &mut alive,
                            );
                        }
                        return Err(mapped);
                    }
                };

                match msg {
                    SimpleQueryMessage::RowDescription(cols) => {
                        emit(
                            QueryEvent::Columns {
                                index,
                                columns: cols
                                    .iter()
                                    .map(|c| ColumnMeta {
                                        name: c.name().to_string(),
                                        type_oid: 0,
                                        table_oid: 0,
                                        attnum: 0,
                                    })
                                    .collect(),
                            },
                            &mut alive,
                        );
                        st = Some(RowState {
                            batch: Vec::with_capacity(ROW_BATCH),
                            truncated: Vec::new(),
                            row_count: 0,
                        });
                    }
                    SimpleQueryMessage::Row(row) => {
                        let state = match st.as_mut() {
                            Some(s) => s,
                            None => continue,
                        };
                        state.row_count += 1;
                        if state.row_count > ROW_CAP {
                            // past the cap nothing more reaches the UI — on the
                            // last statement (or a dead receiver) draining the
                            // rest of a 10M-row result over the wire for
                            // minutes is pure waste: cancel our own query and
                            // treat the 57014 as completion
                            if state.row_count == ROW_CAP + 1
                                && cancellable
                                && (last_statement || !alive)
                            {
                                auto_cancelled = true;
                                let _ = self.cancel().await;
                            }
                            continue; // drain without buffering
                        }
                        let batch_row = state.batch.len() as u32;
                        let mut vals = Vec::with_capacity(row.len());
                        for i in 0..row.len() {
                            match row.get(i) {
                                None => vals.push(None),
                                Some(v) if v.len() > CELL_CAP => {
                                    let mut end = CELL_CAP;
                                    while end > 0 && !v.is_char_boundary(end) {
                                        end -= 1;
                                    }
                                    state.truncated.push((batch_row, i as u32));
                                    vals.push(Some(v[..end].to_string()));
                                }
                                Some(v) => vals.push(Some(v.to_string())),
                            }
                        }
                        state.batch.push(vals);
                        if state.batch.len() >= ROW_BATCH {
                            emit(
                                QueryEvent::Rows {
                                    index,
                                    rows: std::mem::take(&mut state.batch),
                                    truncated: std::mem::take(&mut state.truncated),
                                },
                                &mut alive,
                            );
                        }
                    }
                    SimpleQueryMessage::CommandComplete(affected) => {
                        let (row_count, capped) = match st.take() {
                            Some(mut state) => {
                                if !state.batch.is_empty() {
                                    emit(
                                        QueryEvent::Rows {
                                            index,
                                            rows: std::mem::take(&mut state.batch),
                                            truncated: std::mem::take(&mut state.truncated),
                                        },
                                        &mut alive,
                                    );
                                }
                                (state.row_count, state.row_count > ROW_CAP)
                            }
                            None => (0, false),
                        };
                        emit(
                            QueryEvent::StatementDone {
                                index,
                                // always pass the count through — UPDATE…RETURNING
                                // keeps its affected count alongside its rows
                                affected: Some(affected),
                                ms: started.elapsed().as_secs_f64() * 1000.0,
                                row_count,
                                capped,
                            },
                            &mut alive,
                        );
                    }
                    _ => {}
                }
            }
        }

        emit(
            QueryEvent::Finished {
                total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
            },
            &mut alive,
        );
        Ok(())
    }
}
