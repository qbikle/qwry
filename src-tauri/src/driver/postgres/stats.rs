//! Per-table depth for the Structure tab: constraints, indexes (with scan
//! counts), triggers, sizes, pg_stat activity, comments — one simple-protocol
//! round trip of json cells, same shape as introspect.

use serde::{Deserialize, Serialize};

use super::PgSession;
use crate::driver::{DriverError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstraintInfo {
    pub name: String,
    /// pg_constraint.contype: p/u/f/c/x/t
    pub kind: String,
    /// server deparse (pg_get_constraintdef)
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatInfo {
    pub name: String,
    /// server deparse (pg_get_indexdef)
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
    /// a constraint (PK/UNIQUE/EXCLUDE) owns this index — the never-used
    /// badge must skip it (the constraint is the point, not the scans)
    pub backs_constraint: bool,
    pub size_bytes: i64,
    pub size_pretty: String,
    /// pg_stat_all_indexes.idx_scan; None = no stats row
    pub scans: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    /// server deparse (pg_get_triggerdef)
    pub definition: String,
    /// tgenabled ≠ 'D' (disabled)
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSizes {
    pub table_bytes: i64,
    pub indexes_bytes: i64,
    pub total_bytes: i64,
    pub table_pretty: String,
    pub indexes_pretty: String,
    pub total_pretty: String,
}

/// pg_stat_all_tables row — deliberately NOT pg_stat_user_tables, which
/// drops matviews. Timestamps are wire text; all fields None when the
/// stats collector has no row for the relation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelActivity {
    pub n_live_tup: Option<i64>,
    pub n_dead_tup: Option<i64>,
    pub seq_scan: Option<i64>,
    pub idx_scan: Option<i64>,
    pub last_vacuum: Option<String>,
    pub last_autovacuum: Option<String>,
    pub last_analyze: Option<String>,
    pub last_autoanalyze: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnComment {
    pub column: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStats {
    pub constraints: Vec<ConstraintInfo>,
    pub indexes: Vec<IndexStatInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub sizes: TableSizes,
    /// None = the stats collector has no row (fresh relation, stats reset)
    pub activity: Option<RelActivity>,
    /// COMMENT ON TABLE
    pub comment: Option<String>,
    pub column_comments: Vec<ColumnComment>,
}

impl PgSession {
    /// Structure-tab depth for one relation (table/matview/partitioned/
    /// foreign). Read-only; one round trip.
    pub async fn table_stats(&self, schema: &str, table: &str) -> Result<TableStats> {
        let qi = |n: &str| format!("\"{}\"", n.replace('"', "\"\""));
        // regclass literal: '"sch"."tbl"' with single quotes escaped
        let reg = format!(
            "'{}'",
            format!("{}.{}", qi(schema), qi(table)).replace('\'', "''")
        );
        let sql = format!(
            r#"SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT conname AS name, contype::text AS kind,
         pg_get_constraintdef(oid, true) AS definition
  FROM pg_constraint WHERE conrelid = {reg}::regclass
  ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname
) t;
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT ic.relname AS name,
         pg_get_indexdef(i.indexrelid, 0, true) AS definition,
         i.indisunique AS is_unique, i.indisprimary AS is_primary,
         EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conindid = i.indexrelid) AS backs_constraint,
         pg_relation_size(i.indexrelid) AS size_bytes,
         pg_size_pretty(pg_relation_size(i.indexrelid)) AS size_pretty,
         s.idx_scan AS scans
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
  WHERE i.indrelid = {reg}::regclass
  ORDER BY ic.relname
) t;
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT tgname AS name, pg_get_triggerdef(oid, true) AS definition,
         tgenabled <> 'D' AS enabled
  FROM pg_trigger WHERE tgrelid = {reg}::regclass AND NOT tgisinternal
  ORDER BY tgname
) t;
SELECT json_build_object(
  'table_bytes', pg_table_size({reg}::regclass),
  'indexes_bytes', pg_indexes_size({reg}::regclass),
  'total_bytes', pg_total_relation_size({reg}::regclass),
  'table_pretty', pg_size_pretty(pg_table_size({reg}::regclass)),
  'indexes_pretty', pg_size_pretty(pg_indexes_size({reg}::regclass)),
  'total_pretty', pg_size_pretty(pg_total_relation_size({reg}::regclass)));
SELECT coalesce((SELECT row_to_json(t)::text FROM (
  SELECT n_live_tup, n_dead_tup, seq_scan, idx_scan,
         last_vacuum::text, last_autovacuum::text,
         last_analyze::text, last_autoanalyze::text
  FROM pg_stat_all_tables WHERE relid = {reg}::regclass
) t), 'null');
SELECT json_build_object(
  'table', obj_description({reg}::regclass, 'pg_class'),
  'columns', coalesce((
    SELECT json_agg(json_build_object('column', a.attname, 'comment', d.description) ORDER BY a.attnum)
    FROM pg_attribute a
    JOIN pg_description d ON d.objoid = a.attrelid
      AND d.classoid = 'pg_class'::regclass AND d.objsubid = a.attnum
    WHERE a.attrelid = {reg}::regclass AND a.attnum > 0 AND NOT a.attisdropped
  ), '[]'))"#
        );
        let out = self.execute_simple(&sql).await?;
        if out.statements.len() != 6 {
            return Err(DriverError::Internal(format!(
                "table_stats returned {} result sets, expected 6",
                out.statements.len()
            )));
        }
        let cell = |i: usize| -> Result<String> {
            out.statements[i]
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| v.clone())
                .ok_or_else(|| DriverError::Internal("empty table_stats cell".into()))
        };
        let parse_err =
            |what: &str, e: serde_json::Error| DriverError::Internal(format!("{what}: {e}"));

        #[derive(Deserialize)]
        struct Comments {
            table: Option<String>,
            columns: Vec<ColumnComment>,
        }
        let comments: Comments =
            serde_json::from_str(&cell(5)?).map_err(|e| parse_err("comments", e))?;

        Ok(TableStats {
            constraints: serde_json::from_str(&cell(0)?)
                .map_err(|e| parse_err("constraints", e))?,
            indexes: serde_json::from_str(&cell(1)?).map_err(|e| parse_err("indexes", e))?,
            triggers: serde_json::from_str(&cell(2)?).map_err(|e| parse_err("triggers", e))?,
            sizes: serde_json::from_str(&cell(3)?).map_err(|e| parse_err("sizes", e))?,
            activity: serde_json::from_str(&cell(4)?).map_err(|e| parse_err("activity", e))?,
            comment: comments.table,
            column_comments: comments.columns,
        })
    }
}
