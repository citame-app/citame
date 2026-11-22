#!/usr/bin/env bash
# Validate the exact ZIP recipients will unpack. Optionally open the window on a Mac with a GPU.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "A macOS host and Xcode are required" >&2; exit 1; }
archive="${1:?Pass the Citame ZIP archive}"
arch="${2:-$(uname -m)}"
case "$arch" in x86_64|arm64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
[ "$(uname -m)" = "$arch" ] || { echo "The ZIP must be tested on a native $arch host" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
script_dir="$(cd "$(dirname "$0")" && pwd)"

ditto -x -k "$archive" "$work"
app="$work/Citame.app"
plist="$app/Contents/Info.plist"
binary="$app/Contents/MacOS/sob-desktop"
resources="$app/Contents/Resources"
plutil -lint "$plist"
test "$(plutil -extract CFBundleIdentifier raw -o - "$plist")" = app.citame.desktop
test "$(plutil -extract CFBundleExecutable raw -o - "$plist")" = sob-desktop
test -s "$resources/Citame.icns"
test -x "$binary"
test "$(lipo -archs "$binary")" = "$arch"
minimum="$(plutil -extract LSMinimumSystemVersion raw -o - "$plist")"
test "$minimum" = 15.0
binary_minimum="$(xcrun vtool -show-build "$binary" | awk '$1 == "minos" { print $2 }')"
if ! [[ "$binary_minimum" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] ||
    ! awk -v version="$binary_minimum" 'BEGIN {
      split(version, n, ".");
      exit !(n[1] < 15 || (n[1] == 15 && n[2] == 0 && n[3] == 0));
    }'; then
  echo "Invalid executable minimum for macOS 15.0: ${binary_minimum:-unknown}" >&2
  exit 1
fi
version="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$resources/metadata.json")"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$plist")" = "${version%%-*}"
codesign --verify --strict "$app"
if [ -n "${RELEASE_REVISION:-}" ]; then
  bun "$script_dir/release.ts" verify-metadata < "$resources/metadata.json"
fi
if [ "${CITAME_MAC_REQUIRE_NOTARY:-0}" = 1 ]; then
  xcrun stapler validate "$app"
  spctl --assess --type execute "$app"
fi
test "$("$binary" --check-installation)" = "Citame $version SQLite ready"
echo "Citame $version ZIP verified on $arch"

if [ "${CITAME_MAC_VERIFY_GUI:-0}" = 1 ]; then
  bash "$script_dir/verify-desktop-startup.sh" "$binary"
fi
