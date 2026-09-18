-- Dumps a SchemaSnapshot-shaped JSON (src/stores/schema.ts) for the prefilter
-- fixture. Regenerate against the lab Postgres with:
--
--   psql -h 127.0.0.1 -p 5455 -U lab -d pagila -tAX \
--     -f src/agent/__tests__/fixtures/snapshot.sql > src/agent/__tests__/fixtures/pagila-snapshot.json
--
-- Only the fields context.ts reads are real; the rest of SchemaSnapshot is
-- present and empty, because the fixture is typed as the whole snapshot.
SELECT json_build_object(
  'tables', coalesce((
    SELECT json_agg(x ORDER BY x->>'name')
    FROM (
      SELECT json_build_object(
        'table_oid', c.oid::int,
        'schema', n.nspname,
        'name', c.relname,
        'kind', c.relkind::text,
        'columns', coalesce((
          SELECT json_agg(json_build_object(
            'name', a.attname,
            'attnum', a.attnum,
            'type', format_type(a.atttypid, a.atttypmod),
            'type_oid', a.atttypid::int,
            'not_null', a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid),
            'comment', col_description(c.oid, a.attnum)
          ) ORDER BY a.attnum)
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        ), '[]'::json),
        'pk', coalesce((
          SELECT json_agg(a.attname ORDER BY k.n)
          FROM pg_constraint con
          CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE con.conrelid = c.oid AND con.contype = 'p'
        ), '[]'::json),
        'reltuples', c.reltuples,
        'comment', obj_description(c.oid, 'pg_class'),
        'parent_oid', (SELECT i.inhparent::int FROM pg_inherits i WHERE i.inhrelid = c.oid LIMIT 1)
      ) AS x
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ) s
  ), '[]'::json),
  'foreign_keys', coalesce((
    SELECT json_agg(json_build_object(
      'src_schema', sn.nspname,
      'src_table', sc.relname,
      'src_cols', (
        SELECT json_agg(a.attname ORDER BY k.n)
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
        JOIN pg_attribute a ON a.attrelid = sc.oid AND a.attnum = k.attnum
      ),
      'dst_schema', dn.nspname,
      'dst_table', dc.relname,
      'dst_cols', (
        SELECT json_agg(a.attname ORDER BY k.n)
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, n)
        JOIN pg_attribute a ON a.attrelid = dc.oid AND a.attnum = k.attnum
      )
    ))
    FROM pg_constraint con
    JOIN pg_class sc ON sc.oid = con.conrelid
    JOIN pg_namespace sn ON sn.oid = sc.relnamespace
    JOIN pg_class dc ON dc.oid = con.confrelid
    JOIN pg_namespace dn ON dn.oid = dc.relnamespace
    WHERE con.contype = 'f' AND sn.nspname = 'public'
  ), '[]'::json),
  'functions', '[]'::json,
  'schemas', json_build_array('public'),
  'indexes', '[]'::json,
  'enums', '[]'::json,
  'server_version_num', current_setting('server_version_num')::int
);
