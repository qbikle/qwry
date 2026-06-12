//! Schema introspection: one simple-protocol round trip of four statements,
//! each returning a single json_agg cell. Powers sidebar tree + completion.

use serde::{Deserialize, Serialize};

use super::PgSession;
use crate::driver::{DriverError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub attnum: i16,
    #[serde(rename = "type")]
    pub data_type: String,
    pub type_oid: u32,
    pub not_null: bool,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub table_oid: u32,
    pub schema: String,
    pub name: String,
    /// r = table, v = view, m = matview, p = partitioned, f = foreign
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
    #[serde(default)]
    pub pk: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FkInfo {
    pub src_schema: String,
    pub src_table: String,
    pub src_cols: Vec<String>,
    pub dst_schema: String,
    pub dst_table: String,
    pub dst_cols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuncInfo {
    pub schema: String,
    pub name: String,
    pub args: String,
    pub returns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub schema: String,
    pub table: String,
    pub name: String,
    pub def: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub tables: Vec<TableInfo>,
    pub foreign_keys: Vec<FkInfo>,
    pub functions: Vec<FuncInfo>,
    pub schemas: Vec<String>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
}

const TABLES_SQL: &str = r#"
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT c.oid::int8 AS table_oid, n.nspname AS schema, c.relname AS name,
         c.relkind::text AS kind,
         coalesce((
           SELECT json_agg(json_build_object(
                    'name', a.attname,
                    'attnum', a.attnum,
                    'type', format_type(a.atttypid, a.atttypmod),
                    'type_oid', a.atttypid::int8,
                    'not_null', a.attnotnull,
                    'default', pg_get_expr(d.adbin, d.adrelid))
                  ORDER BY a.attnum)
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         ), '[]') AS columns,
         coalesce((
           SELECT json_agg(a.attname ORDER BY ord.n)
           FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, n)
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
           WHERE i.indrelid = c.oid AND i.indisprimary
         ), '[]') AS pk
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','p','f')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY n.nspname, c.relname
) t"#;

const FKS_SQL: &str = r#"
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT sn.nspname AS src_schema, sc.relname AS src_table,
         (SELECT json_agg(a.attname ORDER BY ord.n)
          FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ord.attnum
         ) AS src_cols,
         dn.nspname AS dst_schema, dc.relname AS dst_table,
         (SELECT json_agg(a.attname ORDER BY ord.n)
          FROM unnest(con.confkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ord.attnum
         ) AS dst_cols
  FROM pg_constraint con
  JOIN pg_class sc ON sc.oid = con.conrelid
  JOIN pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_class dc ON dc.oid = con.confrelid
  JOIN pg_namespace dn ON dn.oid = dc.relnamespace
  WHERE con.contype = 'f'
    AND sn.nspname NOT IN ('pg_catalog','information_schema')
) t"#;

const FUNCS_SQL: &str = r#"
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT n.nspname AS schema, p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS returns
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE (n.nspname = 'pg_catalog' OR n.nspname NOT IN ('information_schema'))
    AND n.nspname NOT LIKE 'pg_toast%'
    AND p.prokind IN ('f','a','w')
) t"#;

const SCHEMAS_SQL: &str = r#"
SELECT coalesce(json_agg(nspname ORDER BY nspname), '[]')
FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog','information_schema')
  AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'"#;

const INDEXES_SQL: &str = r#"
SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS def
  FROM pg_indexes
  WHERE schemaname NOT IN ('pg_catalog','information_schema')
  ORDER BY schemaname, tablename, indexname
) t"#;

impl PgSession {
    pub async fn introspect(&self) -> Result<SchemaSnapshot> {
        let sql = format!("{TABLES_SQL};{FKS_SQL};{FUNCS_SQL};{SCHEMAS_SQL};{INDEXES_SQL}");
        let out = self.execute_simple(&sql).await?;
        if out.statements.len() != 5 {
            return Err(DriverError::Internal(format!(
                "introspection returned {} result sets, expected 5",
                out.statements.len()
            )));
        }
        let cell = |i: usize| -> Result<String> {
            out.statements[i]
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| v.clone())
                .ok_or_else(|| DriverError::Internal("empty introspection cell".into()))
        };
        let parse_err =
            |what: &str, e: serde_json::Error| DriverError::Internal(format!("{what}: {e}"));

        Ok(SchemaSnapshot {
            tables: serde_json::from_str(&cell(0)?).map_err(|e| parse_err("tables", e))?,
            foreign_keys: serde_json::from_str(&cell(1)?).map_err(|e| parse_err("fks", e))?,
            functions: serde_json::from_str(&cell(2)?).map_err(|e| parse_err("functions", e))?,
            schemas: serde_json::from_str(&cell(3)?).map_err(|e| parse_err("schemas", e))?,
            indexes: serde_json::from_str(&cell(4)?).map_err(|e| parse_err("indexes", e))?,
        })
    }
}
