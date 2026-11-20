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
umask 077
mkdir -p "$(dirname "$OUT")"
if [ -e "$OUT" ] || [ -L "$OUT" ] || [ -e "$OUT.sha256" ] || [ -L "$OUT.sha256" ]; then
  echo "backup refused: an archive or checksum already exists for $OUT" >&2
  exit 1
fi
TMP="$(mktemp -d "$OUT.partial.XXXXXX")"
cleanup() {
  # Roll back a checksum published by this process if the archive was not published.
  if [ "$TMP/checksum" -ef "$OUT.sha256" ] && [ ! "$TMP/dump" -ef "$OUT" ]; then
    unlink "$OUT.sha256"
  fi
  rm -f -- "$TMP/dump" "$TMP/checksum"
  rmdir -- "$TMP"
}
trap cleanup EXIT

pg_tool pg_dump "$URL" --format=custom --no-owner --no-privileges > "$TMP/dump"
[ -s "$TMP/dump" ] || { echo "backup failed: empty dump" >&2; exit 1; }
digest="$(sha256_of "$TMP/dump")"
printf '%s  %s\n' "$digest" "$(basename "$OUT")" > "$TMP/checksum"

# Hard links publish complete files and fail if another process owns either destination.
# Publishing the archive last makes its appearance the completion signal.
bun -e '
  import { linkSync } from "node:fs";
  const [, stage, output] = process.argv;
  try {
    linkSync(stage + "/checksum", output + ".sha256");
    linkSync(stage + "/dump", output);
  } catch (error) {
    console.error("backup could not publish the archive and checksum: " + error.code);
    process.exitCode = 1;
  }
' "$TMP" "$OUT"
echo "backup written: $OUT ($(wc -c < "$OUT") bytes)"
