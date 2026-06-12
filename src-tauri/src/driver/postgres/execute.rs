//! Streaming execution over the PG simple protocol. Each statement's rows are
//! batched and emitted through the caller-provided sink as they arrive — no
//! full materialization on the Rust side.

use std::time::Instant;

use futures_util::StreamExt;
use tokio_postgres::SimpleQueryMessage;

use super::splitter::split_statements;
use super::{map_pg_err, PgSession};
use crate::driver::{
    ColumnMeta, DriverError, QueryEvent, Result, CELL_CAP, ROW_BATCH, ROW_CAP,
};

struct StmtState {
    index: u32,
    started: Instant,
    batch: Vec<Vec<Option<String>>>,
    truncated: Vec<(u32, u32)>,
    row_count: u64,
    has_columns: bool,
}

impl PgSession {
    /// Emits QueryEvent through `sink`; a `false` return from the sink means the
    /// receiver hung up — we stop emitting but keep draining the wire.
    pub async fn execute_stream(
        &self,
        sql: &str,
        sink: &mut (dyn FnMut(QueryEvent) -> bool + Send),
    ) -> Result<()> {
        let labels = split_statements(sql);
        let total_start = Instant::now();

        let stream = self
            .client
            .simple_query_raw(sql)
            .await
            .map_err(map_pg_err)?;
        futures_util::pin_mut!(stream);

        let mut alive = true;
        let mut emit = |ev: QueryEvent, alive: &mut bool| {
            if *alive && !sink(ev) {
                *alive = false;
            }
        };

        let label = |i: u32| labels.get(i as usize).cloned().unwrap_or_default();
        let mut index: u32 = 0;
        let mut st: Option<StmtState> = None;
        let mut started_current = false;

        while let Some(msg) = stream.next().await {
            let msg = msg.map_err(|e| {
                let mapped = map_pg_err(e);
                if let DriverError::Db { message, position, code } = &mapped {
                    emit(
                        QueryEvent::Error {
                            index,
                            message: message.clone(),
                            position: *position,
                            code: code.clone(),
                        },
                        &mut alive,
                    );
                }
                mapped
            })?;

            match msg {
                SimpleQueryMessage::RowDescription(cols) => {
                    if !started_current {
                        emit(QueryEvent::StatementStart { index, sql: label(index) }, &mut alive);
                        started_current = true;
                    }
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
                    st = Some(StmtState {
                        index,
                        started: Instant::now(),
                        batch: Vec::with_capacity(ROW_BATCH),
                        truncated: Vec::new(),
                        row_count: 0,
                        has_columns: true,
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    let state = match st.as_mut() {
                        Some(s) => s,
                        None => continue,
                    };
                    state.row_count += 1;
                    if state.row_count > ROW_CAP {
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
                                index: state.index,
                                rows: std::mem::take(&mut state.batch),
                                truncated: std::mem::take(&mut state.truncated),
                            },
                            &mut alive,
                        );
                    }
                }
                SimpleQueryMessage::CommandComplete(affected) => {
                    if !started_current {
                        // statement with no result set (UPDATE/DDL): start it now
                        emit(QueryEvent::StatementStart { index, sql: label(index) }, &mut alive);
                    }
                    let (ms, row_count, capped, had_cols) = match st.take() {
                        Some(mut state) => {
                            if !state.batch.is_empty() {
                                emit(
                                    QueryEvent::Rows {
                                        index: state.index,
                                        rows: std::mem::take(&mut state.batch),
                                        truncated: std::mem::take(&mut state.truncated),
                                    },
                                    &mut alive,
                                );
                            }
                            (
                                state.started.elapsed().as_secs_f64() * 1000.0,
                                state.row_count,
                                state.row_count > ROW_CAP,
                                state.has_columns,
                            )
                        }
                        None => (0.0, 0, false, false),
                    };
                    emit(
                        QueryEvent::StatementDone {
                            index,
                            affected: if had_cols { None } else { Some(affected) },
                            ms,
                            row_count,
                            capped,
                        },
                        &mut alive,
                    );
                    index += 1;
                    started_current = false;
                }
                _ => {}
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
