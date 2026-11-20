#!/usr/bin/env bash
# Load release credentials into a disposable macOS keychain and require notarization.
set -euo pipefail
umask 077
: "${CITAME_MAC_CERTIFICATE_BASE64:?Configure the Developer ID certificate}"
: "${CITAME_MAC_CERTIFICATE_PASSWORD:?Configure the Developer ID certificate password}"
: "${CITAME_MAC_SIGN_IDENTITY:?Configure the Developer ID Application identity}"
: "${CITAME_NOTARY_KEY_BASE64:?Configure the App Store Connect key}"
: "${CITAME_NOTARY_KEY_ID:?Configure the App Store Connect key ID}"
: "${CITAME_NOTARY_ISSUER:?Configure the App Store Connect issuer ID}"

work="$(mktemp -d)"
keychain="$work/citame-release.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
password="$(openssl rand -hex 24)"
printf '%s' "$CITAME_MAC_CERTIFICATE_BASE64" | base64 -D > "$work/developer-id.p12"
printf '%s' "$CITAME_NOTARY_KEY_BASE64" | base64 -D > "$work/notary.p8"
unset CITAME_MAC_CERTIFICATE_BASE64 CITAME_NOTARY_KEY_BASE64

security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/developer-id.p12" -k "$keychain" -P "$CITAME_MAC_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
unset CITAME_MAC_CERTIFICATE_PASSWORD
export CITAME_MAC_KEYCHAIN="$keychain" CITAME_NOTARY_KEY="$work/notary.p8" CITAME_MAC_REQUIRE_NOTARY=1
bash "$(dirname "$0")/package-desktop-macos.sh" "$@"
