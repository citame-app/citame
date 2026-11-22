#!/usr/bin/env bash
# Upgrade an existing Compose deployment after taking its backup.
# Usage: scripts/upgrade-prod.sh [--prebuilt] [--maintenance] [Compose global options]
set -euo pipefail
cd "$(dirname "$0")/.."

build=true
maintenance=false
while [[ "${1:-}" == --prebuilt || "${1:-}" == --maintenance ]]; do
  case "$1" in
    --prebuilt) build=false ;;
    --maintenance) maintenance=true ;;
  esac
  shift
done
compose=(docker compose -f compose.prod.yaml "$@")
edge=("${compose[@]}" --profile tls)

# Compare the rendered service configuration to the existing containers before migrations.
# Keep the configuration, including connection credentials, out of command output.
python3 scripts/check-compose-storage.py upgrade "${compose[@]}"

wait_for_web_api() {
  "${compose[@]}" exec -T web bun -e '
    const deadline = Date.now() + Number(Bun.argv[1]);
    const url = `http://127.0.0.1:${process.env.PORT ?? 4173}/api/ready`;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))),
        });
        const report = await response.json();
        if (response.ok && report.status === "ready") process.exit(0);
      } catch {
        // The gateway or its upstream can still be reconnecting.
      }
      await Bun.sleep(250);
    }
    process.exit(1);
  ' "$1"
}

if [[ "$build" == true ]]; then
  "${compose[@]}" build api web
else
  images=$("${compose[@]}" config --images api worker web migrate)
  while IFS= read -r image; do
    docker image inspect "$image" >/dev/null
  done <<< "$images"
fi

edge_running=$("${edge[@]}" ps --quiet caddy)
if [[ -n "$edge_running" ]]; then
  "${edge[@]}" run --rm --no-deps -T caddy caddy validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile
fi

writers=()
resume_writers() {
  if ! "${compose[@]}" start --wait "${writers[@]}"; then
    printf '%s\n' "The previous API and worker could not both restart. Check their status." >&2
    return 1
  fi
  if grep -Fxq api <<< "$running" &&
     [[ -n $("${compose[@]}" ps --quiet --status running web) ]] &&
     ! wait_for_web_api 3000; then
    # A restarted API can have a new address. Reconnect the web gateway if necessary.
    printf '%s\n' "Restarting the web gateway to reconnect it to the previous API." >&2
    if ! "${compose[@]}" restart --no-deps web || ! wait_for_web_api 15000; then
      printf '%s\n' "The web gateway could not reach the previous API after restart." >&2
      return 1
    fi
  fi
}

migration=(bun packages/db/src/scripts/migrate.ts)
if [[ "$maintenance" == true ]]; then
  running=$("${compose[@]}" ps --services --status running api worker)
  if [[ -n "$running" ]]; then
    mapfile -t writers <<< "$running"
    if ! "${compose[@]}" stop "${writers[@]}"; then
      printf '%s\n' "Could not stop the writers. Restarting the previous API and worker containers." >&2
      resume_writers || true
      exit 1
    fi
  fi
else
  migration+=(--online)
fi

if ! "${compose[@]}" run --rm --no-deps --pull never -T migrate "${migration[@]}"; then
  if (( ${#writers[@]} )); then
    printf '%s\n' "Migration failed. Restarting the previous API and worker containers." >&2
    resume_writers || true
  else
    printf '%s\n' "Migration failed. The running services were left in place." >&2
  fi
  exit 1
fi

"${compose[@]}" up -d --no-deps --no-build --pull never --wait api worker web
if ! wait_for_web_api 15000; then
  printf '%s\n' "The web gateway could not reach the upgraded API. Migration succeeded. Check the API and web configuration." >&2
  exit 1
fi

if [[ -n "$edge_running" ]]; then
  # The old bind mount may still point at the replaced file from the previous checkout.
  "${edge[@]}" up -d --no-deps --no-build --pull never --force-recreate --wait caddy
fi
