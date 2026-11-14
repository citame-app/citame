#!/usr/bin/env bash
# Logical backup of the Sisters of Beauty database: `pg_dump` in custom format (compressed,
# restorable table by table) plus a SHA-256 checksum file.
#
#   scripts/backup.sh [output-file]
#
# DATABASE_URL selects the database (default: the local compose Postgres). The default output is
# backups/sob-<UTC timestamp>.dump. Valkey is not part of this backup, see docs/operations.md.
source "$(dirname "$0")/lib.sh"

URL="${DATABASE_URL:-$DEFAULT_URL}"
OUT="${1:-backups/sob-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.partial"
trap 'rm -f "$TMP"' EXIT

pg_tool pg_dump "$URL" --format=custom --no-owner --no-privileges > "$TMP"
[ -s "$TMP" ] || { echo "backup failed: empty dump" >&2; exit 1; }
mv "$TMP" "$OUT"
printf '%s  %s\n' "$(sha256_of "$OUT")" "$(basename "$OUT")" > "$OUT.sha256"
echo "backup written: $OUT ($(wc -c < "$OUT") bytes)"
