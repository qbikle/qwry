#!/usr/bin/env bash
# Load the vendored Pagila dump into a fresh database and ANALYZE it.
#
# ANALYZE is not optional: describe_tables reads pg_stats for its `-- values:`
# lines (AGENT-SPEC section 5), and a column with no statistics yields no line
# at all. The lab hit this live: an un-analyzed bench looks like a model that
# stopped checking stored values.
#
#   eval/db/load.sh                       # createdb pagila on the default host
#   PGHOST=127.0.0.1 PGPORT=5455 PGUSER=lab eval/db/load.sh pagila
set -euo pipefail

db="${1:-${PGDATABASE:-pagila}}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The dump declares `CREATE EXTENSION IF NOT EXISTS vector` for film_embedding.
# `IF NOT EXISTS` does not cover a missing control file, so on a server without
# pgvector the load dies mid-schema with a bare psql error. Say the cause
# first; a truthful refusal beats a puzzle (LESSONS 5).
# asked of `postgres`, the one database every server has: `$db` does not exist
# yet on a first load, and the implicit default is the login role's name.
if [ "$(psql -tAc "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'" -d postgres)" = "0" ]; then
  echo "this server has no pgvector, and the Pagila dump needs it for film_embedding." >&2
  echo "Install pgvector, or run the bench against an image that ships it" >&2
  echo "(pgvector/pgvector:0.8.6-pg18, which is what .github/workflows/eval.yml uses)." >&2
  exit 1
fi

echo "loading $db from $here"
createdb "$db" 2>/dev/null || echo "  database $db already exists, loading into it"
psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$here/pagila-schema.sql"
psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$here/pagila-data.sql"
psql -v ON_ERROR_STOP=1 -q -d "$db" -c 'ANALYZE'
psql -d "$db" -c "SELECT count(*) AS tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')"
