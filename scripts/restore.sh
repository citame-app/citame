#!/usr/bin/env bash
# Restores a dump made by backup.sh into an EMPTY database (created when missing).
#
#   scripts/restore.sh <dump-file> <target-database-url>
#
# It checks the checksum and archive table of contents before connecting to the target.
# Restore into a fresh database, validate it and then switch DATABASE_URL (see docs/operations.md).
# FORCE=1 skips refusal for an occupied target.
source "$(dirname "$0")/lib.sh"

DUMP="${1:?usage: restore.sh <dump-file> <target-database-url>}"
TARGET="${2:?usage: restore.sh <dump-file> <target-database-url>}"

if [ ! -f "$DUMP.sha256" ]; then
  echo "restore refused: missing checksum file $DUMP.sha256" >&2
  exit 1
fi
expected="$(cut -d' ' -f1 "$DUMP.sha256")"

# Restore the same bytes we verified, even if the source pathname is refreshed.
umask 077
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/citame-restore.XXXXXXXX")"
ARCHIVE="$STAGE/archive.dump"
cleanup() {
  rm -f -- "$ARCHIVE"
  rmdir -- "$STAGE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -- "$DUMP" "$ARCHIVE"
[ "$(sha256_of "$ARCHIVE")" = "$expected" ] || { echo "restore refused: checksum mismatch for $DUMP" >&2; exit 1; }

# Resolve the toolchain for every step before checking or writing any database.
if use_docker pg_restore || use_docker psql; then
  require_docker_socket "$TARGET"
  PG_MODE=docker
fi

if ! read_restore_archive "$TARGET" pg_restore --list < "$ARCHIVE" > /dev/null; then
  echo "restore refused: could not read the PostgreSQL archive table of contents for $DUMP" >&2
  exit 1
fi

DB="$(url_part "$TARGET" db)"
ADMIN="$(admin_url "$TARGET")"
exists="$(pg_tool psql "$ADMIN" -X -v ON_ERROR_STOP=1 -v target_db="$DB" -qAt <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'target_db';
SQL
)"
if [ -z "$exists" ]; then
  pg_tool psql "$ADMIN" -X -v ON_ERROR_STOP=1 -v target_db="$DB" >/dev/null <<'SQL'
CREATE DATABASE :"target_db";
SQL
fi
occupied="$(pg_tool psql "$TARGET" -X -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- information_schema hides tables and other objects from roles without privileges on them.
SELECT EXISTS (
  SELECT FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
) OR EXISTS (
  SELECT FROM pg_catalog.pg_depend AS dependency
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = dependency.refobjid
  WHERE dependency.refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
    AND namespace.nspname = 'public'
) OR EXISTS (
  SELECT FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
) OR EXISTS (
  SELECT FROM pg_catalog.pg_largeobject_metadata
) OR EXISTS (
  SELECT FROM pg_catalog.pg_publication
) OR EXISTS (
  SELECT FROM pg_catalog.pg_event_trigger
) OR EXISTS (
  SELECT FROM pg_catalog.pg_foreign_data_wrapper
) OR EXISTS (
  SELECT FROM pg_catalog.pg_default_acl
);
SQL
)"
if [ "$occupied" != "f" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "restore refused: $DB already has database objects; restore into an empty database" >&2
  exit 1
fi

pg_tool pg_restore "$TARGET" --no-owner --no-privileges --single-transaction --exit-on-error < "$ARCHIVE"
# Logical dumps can omit planner statistics. Collect them before the application opens the database.
if ! pg_tool psql "$TARGET" -X -v ON_ERROR_STOP=1 -q -c 'ANALYZE'; then
  echo "restore loaded $DB, but ANALYZE failed; run ANALYZE on the restored database before switching traffic" >&2
  exit 1
fi
echo "restore finished: $DB"
