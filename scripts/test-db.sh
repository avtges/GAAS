#!/usr/bin/env bash
# Creates a throwaway Postgres database with a Supabase-compatible shim (auth schema,
# roles) and applies all migrations. Used by `npm test`.
#
#   TEST_DATABASE_ADMIN_URL  superuser URL (default postgresql://postgres:postgres@127.0.0.1:5432/postgres)
#   TEST_DATABASE_NAME       database to (re)create (default gaas_test)
set -euo pipefail
ADMIN_URL="${TEST_DATABASE_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
DB_NAME="${TEST_DATABASE_NAME:-gaas_test}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
drop database if exists ${DB_NAME} with (force);
create database ${DB_NAME};
SQL

DB_URL="${ADMIN_URL%/*}/${DB_NAME}"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$DIR/supabase/shim/supabase_shim.sql"
for f in "$DIR"/supabase/migrations/*.sql; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "$DB_URL"
