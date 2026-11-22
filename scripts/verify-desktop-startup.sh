#!/usr/bin/env bash
# Launch the packaged executable on the current display with a disposable profile.
set -euo pipefail

binary="${1:?Pass the packaged Citame executable}"
[[ "$binary" == /* ]] || binary="$PWD/$binary"
if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "Desktop executable is missing or not executable: $binary" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/citame-desktop-frame.XXXXXX")"
app_pid=""
probe_running() {
  # Match one PID in the job table. A signal can interrupt a foreground sleep.
  [[ $'\n'"$(jobs -pr; jobs -ps)"$'\n' == *$'\n'"$app_pid"$'\n'* ]]
}

wait_for_probe_exit() {
  local seconds="$1" attempt
  for ((attempt=0; attempt<seconds; attempt++)); do
    probe_running || return 0
    sleep 1
  done
  ! probe_running
}

cleanup() {
  local cleanup_failed=0
  if [ -n "$app_pid" ]; then
    if probe_running; then
      kill -TERM "$app_pid" 2>/dev/null || true
    fi
    if ! wait_for_probe_exit 3; then
      kill -KILL "$app_pid" 2>/dev/null || true
      if ! wait_for_probe_exit 2; then
        echo "The packaged application's test process did not exit" >&2
        cleanup_failed=1
      fi
    fi
    if [ "$cleanup_failed" = 0 ]; then
      wait "$app_pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$work"
  if [ "$cleanup_failed" != 0 ]; then
    exit "$cleanup_failed"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SOB_DATA_DIR="$work/data" SOB_API_URL="http://127.0.0.1:1" SOB_STARTUP_TIMINGS=1 \
  "$binary" > "$work/startup.log" 2>&1 &
app_pid=$!
for ((elapsed=0; elapsed<=30; elapsed++)); do
  if probe_running &&
      grep -m 1 '^citame startup first frame callback: [0-9][0-9]* ms$' "$work/startup.log"; then
    exit 0
  fi
  if ((elapsed == 30)) || ! probe_running; then break; fi
  sleep 1
done
cat "$work/startup.log" >&2
echo "The packaged application did not open its first window" >&2
exit 1
