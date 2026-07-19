//! CSV/TSV import pipeline.
//!
//! Contract (never lose or lie about a row):
//! - VALIDATE runs the whole file through real batched INSERTs inside a
//!   transaction that ALWAYS rolls back — every value passes the same
//!   `'v'::type` cast discipline the commit run uses, so a clean validate is
//!   a faithful rehearsal. A failing batch is re-run row-by-row under
//!   savepoints to name each bad row exactly; collection stops after
//!   `MAX_ERRORS` with an honest "more errors" flag.
//! - COMMIT is one transaction of batched multi-row INSERTs (500/batch),
//!   all-or-nothing: the first error rolls EVERYTHING back and the report
//!   names the batch (and the row, when the server position lands inside a
//!   tuple). Rows are never silently dropped, padded, or coerced — a short
//!   or long CSV record is a per-row error (`flexible(false)`), and a
//!   client-side bad row aborts a commit run outright.
//!
//! Encoding: UTF-8 only (a bad byte is a per-row error naming the row).
//! Quoting mirrors `driver/postgres/edit.rs` (`ql`/`qi`) — those helpers are
//! module-private there, so byte-identical copies live here with parity
//! tests; keep them in lockstep.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::driver::postgres::PgSession;
use crate::driver::{DriverError, Result, TxState};
use crate::state::AppState;

pub const IMPORT_BATCH: usize = 500;
pub const MAX_ERRORS: usize = 50;
const SNIFF_BYTES: usize = 64 * 1024;
const SNIFF_RECORDS: usize = 40;
const PREVIEW_ROWS: usize = 20;
const DELIM_CANDIDATES: [u8; 4] = [b',', b'\t', b';', b'|'];

/// quote an identifier for SQL (mirror of edit.rs `qi` — keep byte-identical)
fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// quote a text literal (mirror of edit.rs `ql` — keep byte-identical)
fn ql(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// a bare lowercase identifier is safe unquoted in a cast; `"char"` must stay
/// quoted (mirror of edit.rs `safe_type_ident` — keep in lockstep)
fn safe_type_ident(name: &str) -> bool {
    name != "char"
        && !name.is_empty()
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// cast target from catalog names: pg_catalog types by bare name, everything
/// else quoted + schema-qualified (string form of edit.rs `cast_of_type`)
fn cast_for(typname: &str, nspname: &str) -> String {
    if nspname == "pg_catalog" {
        if safe_type_ident(typname) {
            typname.to_string()
        } else {
            qi(typname)
        }
    } else {
        format!("{}.{}", qi(nspname), qi(typname))
    }
}

fn internal(msg: impl Into<String>) -> DriverError {
    DriverError::Internal(msg.into())
}

// ---------------------------------------------------------------------------
// preview / sniffing
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CsvPreview {
    /// the delimiter in effect (sniffed or overridden), as a 1-char string
    pub delimiter: String,
    /// header decision in effect (sniffed or overridden)
    pub has_header: bool,
    /// source column labels: file header names, or "#1".."#N" when headerless
    pub source_columns: Vec<String>,
    /// first rows AFTER the header decision (lossy-decoded for display only)
    pub rows: Vec<Vec<String>>,
    /// data-row count for the whole file (header excluded)
    pub total_rows: u64,
    pub field_count: usize,
}

fn parse_delim(s: &str) -> Result<u8> {
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii() => Ok(c as u8),
        _ => Err(internal(format!("delimiter must be one ASCII character, got {s:?}"))),
    }
}

/// Sample-based delimiter sniff: for each candidate, parse the sample and
/// score by (fields-per-record > 1, consistency of the modal field count,
/// modal field count). Ties fall back to candidate order (comma first).
fn sniff_delimiter(sample: &[u8]) -> u8 {
    let mut best = (false, 0f64, 0usize);
    let mut best_delim = b',';
    for &d in &DELIM_CANDIDATES {
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(d)
            .has_headers(false)
            .flexible(true)
            .from_reader(sample);
        let mut counts: Vec<usize> = Vec::new();
        for rec in rdr.byte_records().take(SNIFF_RECORDS) {
            match rec {
                Ok(r) => counts.push(r.len()),
                Err(_) => break,
            }
        }
        if counts.is_empty() {
            continue;
        }
        let mut freq: HashMap<usize, usize> = HashMap::new();
        for &c in &counts {
            *freq.entry(c).or_insert(0) += 1;
        }
        let (&modal, &n) = freq.iter().max_by_key(|(_, &n)| n).expect("nonempty");
        let score = (modal > 1, n as f64 / counts.len() as f64, modal);
        if score > best {
            best = score;
            best_delim = d;
        }
    }
    best_delim
}

/// crude type classes for header detection — deliberately coarse
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldClass {
    Empty,
    Int,
    Float,
    Bool,
    Date,
    Timestamp,
    Text,
}

fn classify(raw: &str) -> FieldClass {
    let s = raw.trim();
    if s.is_empty() {
        return FieldClass::Empty;
    }
    let lower = s.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "t" | "f" | "yes" | "no") {
        return FieldClass::Bool;
    }
    if s.parse::<i128>().is_ok() {
        return FieldClass::Int;
    }
    if s.parse::<f64>().is_ok() && !lower.contains("inf") && !lower.contains("nan") {
        return FieldClass::Float;
    }
    let b = s.as_bytes();
    let date_prefix = b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit);
    if date_prefix {
        if b.len() == 10 {
            return FieldClass::Date;
        }
        if b.len() > 11 && (b[10] == b' ' || b[10] == b'T') {
            return FieldClass::Timestamp;
        }
    }
    FieldClass::Text
}

/// fold two observed data classes into a column class
fn merge_class(a: FieldClass, b: FieldClass) -> FieldClass {
    use FieldClass::*;
    match (a, b) {
        (Empty, x) | (x, Empty) => x,
        (x, y) if x == y => x,
        (Int, Float) | (Float, Int) => Float,
        (Date, Timestamp) | (Timestamp, Date) => Timestamp,
        _ => Text,
    }
}

/// does a row-1 field's class fit a column's data class?
fn fits(header: FieldClass, col: FieldClass) -> bool {
    use FieldClass::*;
    match (header, col) {
        // no evidence either way — can't prove a mismatch
        (Empty, _) | (_, Empty) | (_, Text) => true,
        (h, c) if h == c => true,
        (Int, Float) => true,
        (Date, Timestamp) => true,
        _ => false,
    }
}

/// Header detection: row 1 is a header only when at least one of its fields
/// TYPE-MISMATCHES the data rows below it. If every row-1 field fits the data
/// (including the all-text case), default to NO header — the sniffer must
/// never eat a headerless file's first data row. Overridable in the UI.
fn detect_header(records: &[Vec<String>]) -> bool {
    if records.len() < 2 {
        return false; // nothing to compare against — never eat the only row
    }
    let width = records[0].len();
    let mut col_class = vec![FieldClass::Empty; width];
    for rec in &records[1..] {
        for (i, cc) in col_class.iter_mut().enumerate() {
            let c = rec.get(i).map(|s| classify(s)).unwrap_or(FieldClass::Empty);
            *cc = merge_class(*cc, c);
        }
    }
    !records[0]
        .iter()
        .enumerate()
        .all(|(i, f)| fits(classify(f), col_class[i]))
}

fn lossy_fields(rec: &csv::ByteRecord) -> Vec<String> {
    rec.iter().map(|f| String::from_utf8_lossy(f).into_owned()).collect()
}

/// Sniff + preview a file: delimiter (overridable), header decision
/// (overridable), first rows, and the full-file data-row count.
pub fn preview(
    path: &str,
    delimiter: Option<&str>,
    has_header: Option<bool>,
) -> Result<CsvPreview> {
    let sample = {
        use std::io::Read;
        let mut f = std::fs::File::open(path)
            .map_err(|e| internal(format!("open {path}: {e}")))?;
        let mut buf = vec![0u8; SNIFF_BYTES];
        let mut filled = 0;
        loop {
            let n = f
                .read(&mut buf[filled..])
                .map_err(|e| internal(format!("read {path}: {e}")))?;
            if n == 0 {
                break;
            }
            filled += n;
            if filled == buf.len() {
                break;
            }
        }
        buf.truncate(filled);
        buf
    };
    if sample.is_empty() {
        return Err(internal("file is empty"));
    }
    let delim = match delimiter {
        Some(d) => parse_delim(d)?,
        None => sniff_delimiter(&sample),
    };

    // sample records with the chosen delimiter drive the header sniff
    let mut sample_records: Vec<Vec<String>> = Vec::new();
    {
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(delim)
            .has_headers(false)
            .flexible(true)
            .from_reader(sample.as_slice());
        for rec in rdr.byte_records().take(SNIFF_RECORDS) {
            match rec {
                Ok(r) => sample_records.push(lossy_fields(&r)),
                Err(_) => break,
            }
        }
    }
    if sample_records.is_empty() {
        return Err(internal("no rows could be parsed from the file"));
    }
    let has_header = match has_header {
        Some(h) => h,
        None => detect_header(&sample_records),
    };

    // full pass: preview rows + honest total (record read attempts count —
    // a malformed record is still a row the import will report on)
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| internal(format!("open {path}: {e}")))?;
    let mut it = rdr.byte_records();
    let first = match it.next() {
        Some(Ok(r)) => lossy_fields(&r),
        Some(Err(e)) => return Err(internal(format!("unreadable first record: {e}"))),
        None => return Err(internal("file has no rows")),
    };
    let field_count = first.len();
    let source_columns: Vec<String> = if has_header {
        first.clone()
    } else {
        (1..=field_count).map(|i| format!("#{i}")).collect()
    };
    let mut rows: Vec<Vec<String>> = Vec::new();
    if !has_header && rows.len() < PREVIEW_ROWS {
        rows.push(first);
    }
    let mut total: u64 = if has_header { 0 } else { 1 };
    for rec in it {
        total += 1;
        if rows.len() < PREVIEW_ROWS {
            if let Ok(r) = &rec {
                rows.push(lossy_fields(r));
            }
        }
    }
    Ok(CsvPreview {
        delimiter: (delim as char).to_string(),
        has_header,
        source_columns,
        rows,
        total_rows: total,
        field_count,
    })
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ImportColumnSpec {
    /// 0-based source field index
    pub src: usize,
    /// target column name (exact, case-sensitive)
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportSpec {
    pub path: String,
    /// 1-char delimiter
    pub delimiter: String,
    pub has_header: bool,
    pub schema: String,
    pub table: String,
    pub columns: Vec<ImportColumnSpec>,
    /// "empty" (empty field → NULL, the CSV convention) | "literal"
    /// ("NULL"/"null" → NULL) | "custom" (null_token → NULL) | "none"
    pub null_mode: String,
    #[serde(default)]
    pub null_token: Option<String>,
    /// "validate" (always rolls back) | "commit" (one all-or-nothing tx)
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub processed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RowIssue {
    /// 1-based data row number (header excluded); 0 = not row-attributable
    pub row: u64,
    /// 1-based file line of the record start; 0 = unknown
    pub line: u64,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub total_rows: u64,
    /// validate: rows that passed; commit: rows persisted (0 unless committed)
    pub ok_rows: u64,
    pub errors: Vec<RowIssue>,
    /// error collection stopped at MAX_ERRORS — "…and possibly more"
    pub more_errors: bool,
    pub committed: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Validate,
    Commit,
}

enum NullRule {
    Empty,
    Literal,
    Custom(String),
    None,
}

impl NullRule {
    fn parse(mode: &str, token: Option<&str>) -> Result<Self> {
        match mode {
            "empty" => Ok(NullRule::Empty),
            "literal" => Ok(NullRule::Literal),
            "custom" => match token {
                Some(t) if !t.is_empty() => Ok(NullRule::Custom(t.to_string())),
                _ => Err(internal("custom NULL rule needs a non-empty token")),
            },
            "none" => Ok(NullRule::None),
            other => Err(internal(format!("unknown null_mode {other:?}"))),
        }
    }

    fn apply(&self, field: String) -> Option<String> {
        match self {
            NullRule::Empty if field.is_empty() => None,
            NullRule::Literal if field.eq_ignore_ascii_case("null") => None,
            NullRule::Custom(t) if field == *t => None,
            _ => Some(field),
        }
    }
}

struct PreparedRow {
    row: u64,
    line: u64,
    values: Vec<Option<String>>,
}

/// codes where continuing to hammer the transaction would only lie — the run
/// aborts with the server's own error instead of 50 copies of it
fn fatal_code(e: &DriverError) -> bool {
    match e {
        DriverError::Db { code: Some(c), .. } => {
            c == "25006"            // read-only transaction (prod safe-mode)
                || c == "25P02"     // tx already aborted — our savepoint dance broke
                || c == "57014"     // cancelled by the user
                || c == "57P01"     // admin shutdown
                || c.starts_with("08") // connection failure
        }
        DriverError::Db { code: None, .. } => false,
        _ => true, // connect/session-level failures are never per-row
    }
}

fn issue_message(e: &DriverError) -> String {
    match e {
        DriverError::Db { message, detail, .. } => match detail {
            Some(d) => format!("{message} — {d}"),
            None => message.clone(),
        },
        other => other.to_string(),
    }
}

/// one VALUES tuple; `casts` aligns with `values`
fn tuple_sql(values: &[Option<String>], casts: &[String]) -> String {
    let parts: Vec<String> = values
        .iter()
        .zip(casts)
        .map(|(v, cast)| match v {
            None => "NULL".to_string(),
            Some(s) => format!("{}::{}", ql(s), cast),
        })
        .collect();
    format!("({})", parts.join(", "))
}

/// Multi-row INSERT plus per-row 1-based CHAR spans (PG error positions are
/// char offsets), so a server error position names the tuple it fell in.
fn build_insert(
    schema: &str,
    table: &str,
    targets: &[String],
    casts: &[String],
    rows: &[PreparedRow],
) -> (String, Vec<(u64, usize, usize)>) {
    let cols = targets.iter().map(|t| qi(t)).collect::<Vec<_>>().join(", ");
    let prefix = format!("INSERT INTO {}.{} ({cols}) VALUES\n", qi(schema), qi(table));
    let mut sql = prefix.clone();
    let mut acc = prefix.chars().count();
    let mut spans = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        let t = tuple_sql(&r.values, casts);
        let t_chars = t.chars().count();
        spans.push((r.row, acc + 1, acc + t_chars));
        sql.push_str(&t);
        acc += t_chars;
        if i + 1 < rows.len() {
            sql.push_str(",\n");
            acc += 2;
        }
    }
    (sql, spans)
}

/// the data row whose tuple contains the 1-based char position, if any
fn row_at(spans: &[(u64, usize, usize)], pos: usize) -> Option<u64> {
    spans
        .iter()
        .find(|(_, s, e)| pos >= *s && pos <= *e)
        .map(|(row, _, _)| *row)
}

/// per-target `::cast` names resolved from the live catalog (same discipline
/// as edit.rs cast_of_type); also verifies every target column exists
async fn fetch_casts(
    session: &PgSession,
    schema: &str,
    table: &str,
    columns: &[ImportColumnSpec],
) -> Result<Vec<String>> {
    let dotted = format!("{}.{}", qi(schema), qi(table));
    let sql = format!(
        "SELECT a.attname, t.typname, n.nspname \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE a.attrelid = {}::regclass AND a.attnum > 0 AND NOT a.attisdropped",
        ql(&dotted)
    );
    let out = session.execute_simple(&sql).await?;
    let mut by_name: HashMap<String, String> = HashMap::new();
    if let Some(stmt) = out.statements.first() {
        for r in &stmt.rows {
            if let (Some(Some(name)), Some(Some(ty)), Some(Some(ns))) =
                (r.first(), r.get(1), r.get(2))
            {
                by_name.insert(name.clone(), cast_for(ty, ns));
            }
        }
    }
    columns
        .iter()
        .map(|c| {
            by_name.get(&c.target).cloned().ok_or_else(|| {
                internal(format!("column \"{}\" does not exist on {dotted}", c.target))
            })
        })
        .collect()
}

fn count_data_rows(path: &str, delim: u8, has_header: bool) -> Result<u64> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| internal(format!("open {path}: {e}")))?;
    let mut total: u64 = 0;
    for _ in rdr.byte_records() {
        total += 1;
    }
    Ok(total.saturating_sub(if has_header { 1 } else { 0 }))
}

/// map one parsed record into target values, or a row-attributed issue
fn prepare_row(
    rec: std::result::Result<csv::ByteRecord, csv::Error>,
    row: u64,
    spec: &ImportSpec,
    rule: &NullRule,
) -> std::result::Result<PreparedRow, RowIssue> {
    let rec = match rec {
        Ok(r) => r,
        Err(e) => {
            let line = e
                .position()
                .map(csv::Position::line)
                .unwrap_or(0);
            let message = match e.kind() {
                csv::ErrorKind::UnequalLengths { expected_len, len, .. } => format!(
                    "row has {len} fields, expected {expected_len} — short/long rows are errors, never padded"
                ),
                _ => e.to_string(),
            };
            return Err(RowIssue { row, line, message });
        }
    };
    let line = rec.position().map(csv::Position::line).unwrap_or(0);
    let mut values = Vec::with_capacity(spec.columns.len());
    for c in &spec.columns {
        let Some(raw) = rec.get(c.src) else {
            return Err(RowIssue {
                row,
                line,
                message: format!(
                    "row has {} fields — mapped source column {} is missing",
                    rec.len(),
                    c.src + 1
                ),
            });
        };
        let s = match std::str::from_utf8(raw) {
            Ok(s) => s.to_string(),
            Err(_) => {
                return Err(RowIssue {
                    row,
                    line,
                    message: format!(
                        "invalid UTF-8 in source column {} (only UTF-8 files are supported)",
                        c.src + 1
                    ),
                })
            }
        };
        values.push(rule.apply(s));
    }
    Ok(PreparedRow { row, line, values })
}

/// Run an import. VALIDATE: everything inside BEGIN … ROLLBACK, per-row error
/// attribution via savepoint re-runs, stops collecting after MAX_ERRORS.
/// COMMIT: one transaction, all-or-nothing; any error → ROLLBACK, report
/// names the batch (+ row when position-attributable). Progress is
/// (rows processed, total data rows), emitted per batch.
pub async fn run_import(
    session: &PgSession,
    spec: &ImportSpec,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<ImportReport> {
    let delim = parse_delim(&spec.delimiter)?;
    let mode = match spec.mode.as_str() {
        "validate" => Mode::Validate,
        "commit" => Mode::Commit,
        other => return Err(internal(format!("unknown import mode {other:?}"))),
    };
    let rule = NullRule::parse(&spec.null_mode, spec.null_token.as_deref())?;
    if spec.columns.is_empty() {
        return Err(internal("no columns mapped"));
    }
    let mut seen = HashSet::new();
    for c in &spec.columns {
        if !seen.insert(c.target.as_str()) {
            return Err(internal(format!(
                "target column \"{}\" is mapped more than once",
                c.target
            )));
        }
    }
    if session.tx_state() != TxState::Idle {
        return Err(internal(
            "this session has an open transaction — COMMIT or ROLLBACK it first, then import",
        ));
    }

    let casts = fetch_casts(session, &spec.schema, &spec.table, &spec.columns).await?;
    let targets: Vec<String> = spec.columns.iter().map(|c| c.target.clone()).collect();

    let total = {
        let (path, has_header) = (spec.path.clone(), spec.has_header);
        tauri::async_runtime::spawn_blocking(move || count_data_rows(&path, delim, has_header))
            .await
            .map_err(|e| internal(format!("count task failed: {e}")))??
    };
    if total == 0 {
        return Err(internal("no data rows in file"));
    }
    on_progress(0, total);

    session.execute_simple("BEGIN").await?;
    let body = import_body(
        session, spec, &rule, delim, mode, &targets, &casts, total, on_progress,
    )
    .await;
    match (mode, body) {
        (_, Err(e)) => {
            // fatal path — undo everything this run did, then surface honestly
            let _ = session.execute_simple("ROLLBACK").await;
            Err(e)
        }
        (Mode::Validate, Ok(report)) => {
            // the validate contract: NOTHING persists (no COMMIT was ever
            // issued, so even a failed ROLLBACK can't have committed rows)
            session.execute_simple("ROLLBACK").await?;
            Ok(report)
        }
        (Mode::Commit, Ok(mut report)) => {
            if report.errors.is_empty() {
                match session.execute_simple("COMMIT").await {
                    // ok_rows already accumulated per batch — the true count
                    // even if the file changed between the count pass and now
                    Ok(_) => report.committed = true,
                    Err(e) => {
                        // deferred constraints can fail AT commit — the tx is
                        // gone either way; report it, nothing persisted
                        let _ = session.execute_simple("ROLLBACK").await;
                        report.errors.push(RowIssue {
                            row: 0,
                            line: 0,
                            message: format!("COMMIT failed — nothing imported: {}", issue_message(&e)),
                        });
                        report.ok_rows = 0;
                    }
                }
            } else {
                let _ = session.execute_simple("ROLLBACK").await;
                report.ok_rows = 0;
            }
            Ok(report)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn import_body(
    session: &PgSession,
    spec: &ImportSpec,
    rule: &NullRule,
    delim: u8,
    mode: Mode,
    targets: &[String],
    casts: &[String],
    total: u64,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<ImportReport> {
    let mut report = ImportReport {
        total_rows: total,
        ok_rows: 0,
        errors: Vec::new(),
        more_errors: false,
        committed: false,
    };
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(false)
        .from_path(&spec.path)
        .map_err(|e| internal(format!("open {}: {e}", spec.path)))?;
    let mut it = rdr.byte_records();
    if spec.has_header {
        match it.next() {
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(internal(format!("unreadable header record: {e}"))),
            None => return Err(internal("file has no rows")),
        }
    }

    let mut batch: Vec<PreparedRow> = Vec::with_capacity(IMPORT_BATCH);
    let mut batch_no: u32 = 0;
    let mut row_no: u64 = 0;
    let mut stopped = false;

    for rec in it {
        row_no += 1;
        match prepare_row(rec, row_no, spec, rule) {
            Ok(p) => batch.push(p),
            Err(issue) => {
                if mode == Mode::Commit {
                    // all-or-nothing: a row we can't even parse aborts the run
                    report.errors.push(issue);
                    return Ok(report);
                }
                report.errors.push(issue);
                if report.errors.len() >= MAX_ERRORS {
                    report.more_errors = true;
                    stopped = true;
                    break;
                }
            }
        }
        if batch.len() == IMPORT_BATCH {
            batch_no += 1;
            let go = flush_batch(session, spec, mode, targets, casts, batch_no, &batch, &mut report)
                .await?;
            batch.clear();
            on_progress(row_no, total);
            if !go {
                stopped = true;
                break;
            }
        }
    }
    if !stopped && !batch.is_empty() {
        batch_no += 1;
        flush_batch(session, spec, mode, targets, casts, batch_no, &batch, &mut report).await?;
        on_progress(row_no, total);
    }
    on_progress(row_no.min(total), total);
    Ok(report)
}

/// Execute one batch. Returns Ok(false) when the run should stop (error
/// budget blown in validate, or any failure in commit mode). Err = fatal.
#[allow(clippy::too_many_arguments)]
async fn flush_batch(
    session: &PgSession,
    spec: &ImportSpec,
    mode: Mode,
    targets: &[String],
    casts: &[String],
    batch_no: u32,
    batch: &[PreparedRow],
    report: &mut ImportReport,
) -> Result<bool> {
    let (insert, spans) = build_insert(&spec.schema, &spec.table, targets, casts, batch);
    match mode {
        Mode::Commit => match session.execute_simple(&insert).await {
            Ok(_) => {
                report.ok_rows += batch.len() as u64;
                Ok(true)
            }
            Err(e) if fatal_code(&e) => Err(e),
            Err(e) => {
                let first = batch.first().map(|r| r.row).unwrap_or(0);
                let last = batch.last().map(|r| r.row).unwrap_or(0);
                let pos_row = match &e {
                    DriverError::Db { position: Some(p), .. } => row_at(&spans, *p as usize),
                    _ => None,
                };
                let (row, line) = match pos_row {
                    Some(r) => (r, batch.iter().find(|b| b.row == r).map(|b| b.line).unwrap_or(0)),
                    None => (0, 0),
                };
                let at = match pos_row {
                    Some(r) => format!("batch {batch_no}, row {r}"),
                    None => format!("batch {batch_no} (rows {first}–{last})"),
                };
                report.errors.push(RowIssue {
                    row,
                    line,
                    message: format!("{at}: {}", issue_message(&e)),
                });
                Ok(false)
            }
        },
        Mode::Validate => {
            let combined = format!("SAVEPOINT qwry_import_sp;\n{insert}");
            match session.execute_simple(&combined).await {
                Ok(_) => {
                    report.ok_rows += batch.len() as u64;
                    Ok(true)
                }
                Err(e) if fatal_code(&e) => Err(e),
                Err(_) => {
                    session
                        .execute_simple("ROLLBACK TO SAVEPOINT qwry_import_sp")
                        .await?;
                    // name every bad row exactly: re-run one by one, keeping
                    // good rows applied so intra-file duplicates still trip
                    for r in batch {
                        let (one, _) =
                            build_insert(&spec.schema, &spec.table, targets, casts, std::slice::from_ref(r));
                        let single = format!("SAVEPOINT qwry_import_row;\n{one}");
                        match session.execute_simple(&single).await {
                            Ok(_) => report.ok_rows += 1,
                            Err(e) if fatal_code(&e) => return Err(e),
                            Err(e) => {
                                session
                                    .execute_simple("ROLLBACK TO SAVEPOINT qwry_import_row")
                                    .await?;
                                report.errors.push(RowIssue {
                                    row: r.row,
                                    line: r.line,
                                    message: issue_message(&e),
                                });
                                if report.errors.len() >= MAX_ERRORS {
                                    report.more_errors = true;
                                    return Ok(false);
                                }
                            }
                        }
                    }
                    Ok(true)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn csv_preview(
    path: String,
    delimiter: Option<String>,
    has_header: Option<bool>,
) -> Result<CsvPreview> {
    tauri::async_runtime::spawn_blocking(move || preview(&path, delimiter.as_deref(), has_header))
        .await
        .map_err(|e| internal(format!("preview task failed: {e}")))?
}

#[tauri::command]
pub async fn csv_import(
    state: State<'_, AppState>,
    session_id: String,
    spec: ImportSpec,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportReport> {
    let session = state
        .session(&session_id)
        .ok_or(DriverError::NoSession)?;
    let mut cb = move |processed: u64, total: u64| {
        let _ = on_progress.send(ImportProgress { processed, total });
    };
    run_import(&session, &spec, &mut cb).await
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_edit_rs_rules() {
        // parity contract with edit.rs ql/qi — if these fail, the mirrors drifted
        assert_eq!(ql("it's"), "'it''s'");
        assert_eq!(ql(""), "''");
        assert_eq!(ql("a''b"), "'a''''b'");
        assert_eq!(ql("no quotes"), "'no quotes'");
        assert_eq!(qi("simple"), "\"simple\"");
        assert_eq!(qi("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(cast_for("int4", "pg_catalog"), "int4");
        assert_eq!(cast_for("char", "pg_catalog"), "\"char\"");
        assert_eq!(cast_for("_int4", "pg_catalog"), "\"_int4\"");
        assert_eq!(cast_for("MyType", "public"), "\"public\".\"MyType\"");
    }

    #[test]
    fn sniffs_common_delimiters() {
        assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3\n4,5,6\n"), b',');
        assert_eq!(sniff_delimiter(b"a\tb\tc\n1\t2\t3\n"), b'\t');
        assert_eq!(sniff_delimiter(b"a;b;c\n1;2;3\n"), b';');
        assert_eq!(sniff_delimiter(b"a|b|c\n1|2|3\n"), b'|');
        // commas inside quotes don't fool the semicolon file
        assert_eq!(sniff_delimiter(b"\"x,y\";b\n\"1,2\";3\n"), b';');
        // single column, no delimiter at all — comma default
        assert_eq!(sniff_delimiter(b"solo\nrows\n"), b',');
    }

    fn rows(v: &[&[&str]]) -> Vec<Vec<String>> {
        v.iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    #[test]
    fn header_detected_over_typed_columns() {
        assert!(detect_header(&rows(&[
            &["id", "amount", "created_at"],
            &["1", "3.5", "2026-01-01"],
            &["2", "4.0", "2026-01-02"],
        ])));
    }

    #[test]
    fn headerless_typed_file_keeps_first_row() {
        // row 1 type-matches the data rows → NOT a header (never eat data)
        assert!(!detect_header(&rows(&[
            &["1", "3.5", "2026-01-01"],
            &["2", "4.0", "2026-01-02"],
        ])));
    }

    #[test]
    fn all_text_file_defaults_to_no_header() {
        // every field fits Text — no type evidence, default keeps row 1 as data
        assert!(!detect_header(&rows(&[
            &["name", "city"],
            &["ada", "london"],
        ])));
        // single record: nothing to compare — never eat the only row
        assert!(!detect_header(&rows(&[&["a", "b"]])));
    }

    #[test]
    fn null_rules() {
        let empty = NullRule::Empty;
        assert_eq!(empty.apply("".into()), None);
        assert_eq!(empty.apply("NULL".into()), Some("NULL".into()));
        let lit = NullRule::Literal;
        assert_eq!(lit.apply("null".into()), None);
        assert_eq!(lit.apply("".into()), Some("".into()));
        let custom = NullRule::Custom("\\N".into());
        assert_eq!(custom.apply("\\N".into()), None);
        assert_eq!(custom.apply("".into()), Some("".into()));
        let none = NullRule::None;
        assert_eq!(none.apply("".into()), Some("".into()));
    }

    #[test]
    fn insert_spans_attribute_positions_to_rows() {
        let batch = vec![
            PreparedRow { row: 1, line: 1, values: vec![Some("1".into()), Some("it's".into())] },
            PreparedRow { row: 2, line: 2, values: vec![None, Some("bób".into())] },
        ];
        let (sql, spans) = build_insert(
            "public",
            "t",
            &["a".into(), "b".into()],
            &["int4".into(), "text".into()],
            &batch,
        );
        assert!(sql.starts_with("INSERT INTO \"public\".\"t\" (\"a\", \"b\") VALUES\n"));
        assert!(sql.contains("('1'::int4, 'it''s'::text),\n(NULL, 'bób'::text)"));
        // find the char position of each tuple's opening paren (1-based)
        let chars: Vec<char> = sql.chars().collect();
        for (row, start, end) in &spans {
            assert_eq!(chars[start - 1], '(', "row {row} span start");
            assert_eq!(chars[end - 1], ')', "row {row} span end");
        }
        // a position inside tuple 2 (multibyte char before it!) maps to row 2
        let p2 = spans[1].1 + 1;
        assert_eq!(row_at(&spans, p2), Some(2));
        assert_eq!(row_at(&spans, spans[0].1), Some(1));
        // the separator between tuples belongs to no row
        assert_eq!(row_at(&spans, spans[0].2 + 1), None);
    }

    #[test]
    fn classify_families() {
        assert_eq!(classify("42"), FieldClass::Int);
        assert_eq!(classify("-3.14"), FieldClass::Float);
        assert_eq!(classify("true"), FieldClass::Bool);
        assert_eq!(classify("2026-07-18"), FieldClass::Date);
        assert_eq!(classify("2026-07-18 10:00:00"), FieldClass::Timestamp);
        assert_eq!(classify("2026-07-18T10:00:00Z"), FieldClass::Timestamp);
        assert_eq!(classify("hello"), FieldClass::Text);
        assert_eq!(classify("  "), FieldClass::Empty);
        assert_eq!(classify("inf"), FieldClass::Text);
    }

    #[test]
    fn delimiter_parsing() {
        assert_eq!(parse_delim(",").unwrap(), b',');
        assert_eq!(parse_delim("\t").unwrap(), b'\t');
        assert!(parse_delim("").is_err());
        assert!(parse_delim(",,").is_err());
        assert!(parse_delim("é").is_err());
    }
}
