#!/usr/bin/env bash
# Restores a dump made by backup.sh into an EMPTY database (created when missing).
#
#   scripts/restore.sh <dump-file> <target-database-url>
#
# It verifies the checksum first and refuses a target that already has tables, so a restore can
# never silently overwrite live data. To replace a database, restore into a fresh one, check it,
# then switch DATABASE_URL (see docs/operations.md). FORCE=1 skips the emptiness check.
source "$(dirname "$0")/lib.sh"

DUMP="${1:?usage: restore.sh <dump-file> <target-database-url>}"
TARGET="${2:?usage: restore.sh <dump-file> <target-database-url>}"

if [ -f "$DUMP.sha256" ]; then
  expected="$(cut -d' ' -f1 "$DUMP.sha256")"
  [ "$(sha256_of "$DUMP")" = "$expected" ] || { echo "restore refused: checksum mismatch for $DUMP" >&2; exit 1; }
else
  echo "warning: no $DUMP.sha256, integrity not verified" >&2
fi

DB="$(url_part "$TARGET" db)"
ADMIN="$(admin_url "$TARGET")"
exists="$(pg_tool psql "$ADMIN" -tAc "select 1 from pg_database where datname = '$DB'")"
if [ -z "$exists" ]; then
  pg_tool psql "$ADMIN" -v ON_ERROR_STOP=1 -c "create database \"$DB\"" >/dev/null
fi
tables="$(pg_tool psql "$TARGET" -tAc "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")"
if [ "$tables" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "restore refused: $DB already has $tables table(s); restore into an empty database" >&2
  exit 1
fi

pg_tool pg_restore "$TARGET" --no-owner --no-privileges --exit-on-error < "$DUMP"
echo "restore finished: $DB"
