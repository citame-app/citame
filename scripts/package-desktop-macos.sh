#!/usr/bin/env bash
# Package a native macOS build into a Finder-launchable application.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "A macOS host and Xcode are required" >&2; exit 1; }
arch="$(uname -m)"
case "$arch" in x86_64|arm64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
binary="${1:-apps/desktop/target/release/sob-desktop}"
output="${2:-.release/desktop}"
[ -x "$binary" ] || { echo "Desktop executable is missing: $binary" >&2; exit 1; }
[ "$(lipo -archs "$binary")" = "$arch" ] || { echo "Unexpected binary architecture" >&2; exit 1; }
identity="${CITAME_MAC_SIGN_IDENTITY:-}"
if [ -n "$identity" ] || [ "${CITAME_MAC_REQUIRE_NOTARY:-0}" = 1 ]; then
  [[ "$identity" == "Developer ID Application: "* ]] ||
    { echo "A Developer ID Application identity is required" >&2; exit 1; }
  [ -r "${CITAME_NOTARY_KEY:-}" ] && [ -n "${CITAME_NOTARY_KEY_ID:-}" ] &&
    [ -n "${CITAME_NOTARY_ISSUER:-}" ] ||
    { echo "App Store Connect notarization credentials are required" >&2; exit 1; }
fi

bun scripts/release.ts validate
metadata="${RELEASE_OUTPUT_DIR:-.release}/metadata.json"
version="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$metadata")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
app="$work/Citame.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$output"
output="$(cd "$output" && pwd)"
cp "$binary" "$app/Contents/MacOS/sob-desktop"
cp LICENSE apps/desktop/README.md "$metadata" "$app/Contents/Resources/"
iconset="$work/Citame.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" apps/web/public/icon-512.png \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" apps/web/public/icon-512.png \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Citame.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>app.citame.desktop</string>
    <key>CFBundleName</key><string>Citame</string>
    <key>CFBundleDisplayName</key><string>Citame</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>sob-desktop</string>
    <key>CFBundleIconFile</key><string>Citame.icns</string>
    <key>CFBundleShortVersionString</key><string>${version%%-*}</string>
    <key>CFBundleVersion</key><string>${version%%-*}</string>
    <key>LSMinimumSystemVersion</key><string>15.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
if [ -n "$identity" ]; then
  sign_options=(--force --options runtime --timestamp --sign "$identity")
  if [ -n "${CITAME_MAC_KEYCHAIN:-}" ]; then sign_options+=(--keychain "$CITAME_MAC_KEYCHAIN"); fi
  codesign "${sign_options[@]}" "$app"
  codesign --verify --strict "$app"
  ditto -c -k --keepParent "$app" "$work/submission.zip"
  xcrun notarytool submit "$work/submission.zip" --wait --timeout 20m --output-format json \
    --key "$CITAME_NOTARY_KEY" --key-id "$CITAME_NOTARY_KEY_ID" --issuer "$CITAME_NOTARY_ISSUER" \
    > "$work/notarization.json"
  bun -e 'const result = await Bun.file(process.argv[1]).json();
    if (result.status !== "Accepted") throw new Error(`Notarization ${result.id}: ${result.status}`);' \
    "$work/notarization.json"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute "$app"
else
  codesign --force --sign - "$app"
  codesign --verify --strict "$app"
fi
name="sisters-of-beauty-desktop-$version-macos-$arch.zip"
archive="$work/$name"
ditto -c -k --keepParent "$app" "$archive"
if [ -n "$identity" ]; then
  CITAME_MAC_REQUIRE_NOTARY=1 bash scripts/verify-desktop-macos.sh "$archive" "$arch"
else
  bash scripts/verify-desktop-macos.sh "$archive" "$arch"
fi
mv "$archive" "$output/$name"
(cd "$output" && shasum -a 256 "$name" > "$name.sha256")
echo "Desktop package: $output/$name"
