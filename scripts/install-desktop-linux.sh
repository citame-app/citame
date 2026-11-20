#!/usr/bin/env bash
# Install from an extracted Citame Linux archive for the current user.
set -euo pipefail

[ "$(uname -s)" = Linux ] || { echo "This installer targets Linux" >&2; exit 1; }
bundle="$(cd "$(dirname "$0")" && pwd)"
[ -x "$bundle/sob-desktop" ] && [ -r "$bundle/icon.svg" ] || {
  echo "Extract the full Citame archive before installing it" >&2
  exit 1
}

data="${XDG_DATA_HOME:-$HOME/.local/share}"
case "$data" in
  /*) ;;
  *) data="$HOME/.local/share" ;;
esac
case "${data//$'\t'/}" in
  *[[:cntrl:]]*) echo "The desktop installation path contains an unsupported control character" >&2; exit 1 ;;
esac

app_id=app.citame.desktop
bin_dir="$data/citame/bin"
icon_dir="$data/icons/hicolor/scalable/apps"
app_dir="$data/applications"
mkdir -p "$bin_dir" "$icon_dir" "$app_dir"
binary="$(mktemp "$bin_dir/.sob-desktop.XXXXXX")"
icon=""
launcher=""
trap 'rm -f -- "$binary" "${icon:-}" "${launcher:-}"' EXIT
icon="$(mktemp "$icon_dir/.$app_id.XXXXXX")"
launcher="$(mktemp "$app_dir/.$app_id.XXXXXX")"

install -m 755 "$bundle/sob-desktop" "$binary"
install -m 644 "$bundle/icon.svg" "$icon"
# Escape the quoted Exec argument and then the desktop-entry string that contains it.
exec_path="$(printf '%s' "$bin_dir/sob-desktop" | sed -e 's/[\\"$`]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g' -e $'s/\t/\\\\t/g')"
cat > "$launcher" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Citame
Comment=Appointments and salon reception
Comment[es]=Agenda y recepción del centro
Exec=/usr/bin/env -- "$exec_path"
Icon=$app_id
Terminal=false
Categories=Office;Calendar;
DESKTOP
chmod 644 "$launcher"

mv -fT -- "$binary" "$bin_dir/sob-desktop"
mv -fT -- "$icon" "$icon_dir/$app_id.svg"
mv -fT -- "$launcher" "$app_dir/$app_id.desktop"
printf 'Citame is installed. Launch it from the applications menu or run %s\n' "$bin_dir/sob-desktop"
