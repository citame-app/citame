#!/usr/bin/env bash
# Build the binary separately, then package it without publishing or installing anything.
# Usage: scripts/package-desktop.sh [binary] [output-directory]
set -euo pipefail
cd "$(dirname "$0")/.."
binary="${1:-apps/desktop/target/release/sob-desktop}"
output="${2:-.release/desktop}"
if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "Desktop executable is missing or not executable: $binary" >&2
  exit 1
fi
[ "$(uname -s)" = Linux ] || { echo "This package targets Linux" >&2; exit 1; }
arch="$(uname -m)"
case "$arch" in x86_64|aarch64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
bun scripts/release.ts validate
metadata="${RELEASE_OUTPUT_DIR:-.release}/metadata.json"
version="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$metadata")"
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
[[ "$epoch" =~ ^[0-9]+$ ]] || { echo "Invalid SOURCE_DATE_EPOCH" >&2; exit 1; }
name="sisters-of-beauty-desktop-$version-linux-$arch"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -m 755 "$work/$name"
mkdir -p "$output"
install -m 755 "$binary" "$work/$name/sob-desktop"
install -m 644 LICENSE apps/desktop/README.md "$work/$name/"
install -m 755 scripts/install-desktop-linux.sh "$work/$name/install.sh"
install -m 644 apps/web/public/favicon.svg "$work/$name/icon.svg"
install -m 644 "$metadata" "$work/$name/release.json"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --format=gnu \
  -C "$work" -cf - "$name" | gzip -n > "$output/$name.tar.gz"
(cd "$output"; sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "Desktop package: $output/$name.tar.gz"
