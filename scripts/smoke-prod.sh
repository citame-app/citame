#!/usr/bin/env bash
# End-to-end smoke test of compose.prod.yaml: builds and starts the stack, creates the owner,
# loads the demo catalogue, then drives it through the reverse proxy like a visitor would:
# readiness, owner sign-in, public availability, a client signing up and booking. Tears
# everything down (including volumes) at the end.
#
#   scripts/smoke-prod.sh            # uses Caddy on http://localhost:8088 (profile tls, SITE_ADDRESS=:80)
set -euo pipefail
cd "$(dirname "$0")/.."

# Never reuse a deployment's project, volumes, images or .env during a destructive smoke run.
SMOKE_PROJECT="sob-smoke-$(openssl rand -hex 8)"
SMOKE_DIR="$(mktemp -d)"
export SOB_TAG="$SMOKE_PROJECT"
export POSTGRES_PASSWORD="smoke-$(openssl rand -hex 8)"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export PUBLIC_URL="http://localhost:8088"
export SITE_ADDRESS=":80" CADDY_HTTP_PORT=8088 CADDY_HTTPS_PORT=8443
export WEB_PUBLISH="127.0.0.1:0"
# Caddy (profile tls) is the trusted edge in front of web.
export WEB_TRUST_PROXY=true
# The smoke environment has no mail server: opt out of verification explicitly (production
# refuses to start with verification required and no provider, see ADR 0011).
export AUTH_REQUIRE_EMAIL_VERIFICATION=false NOTIFY_EMAIL_PROVIDER=none NOTIFY_SMS_PROVIDER=none
export OWNER_EMAIL=smoke-owner@example.com OWNER_PASSWORD="smoke passphrase $(openssl rand -hex 4)"
COMPOSE=(docker compose --project-name "$SMOKE_PROJECT" --env-file /dev/null -f compose.prod.yaml --profile tls)
BASE="http://localhost:8088"

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "sob-api:$SOB_TAG" "sob-web:$SOB_TAG" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { echo "SMOKE FAILED: $*" >&2; "${COMPOSE[@]}" logs --tail 40 >&2 || true; exit 1; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

step "config"
"${COMPOSE[@]}" config -q

step "build and start (migrations run as a one-shot job first)"
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300

step "services"
"${COMPOSE[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
"${COMPOSE[@]}" ps -a --format '{{.Service}} {{.State}} exit={{.ExitCode}}' | grep -E '^migrate ' || true

step "first owner and demo catalogue"
"${COMPOSE[@]}" run --rm bootstrap-owner
"${COMPOSE[@]}" run --rm --no-deps migrate bun packages/db/src/scripts/seed.ts

step "readiness and liveness through the proxy"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = 200 ] || fail "/healthz"
ready="$(curl -s "$BASE/api/ready")"; echo "$ready"
echo "$ready" | grep -q '"status":"ready"' || fail "/api/ready: $ready"

step "metrics are not public"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/metrics")" = 404 ] || fail "/api/metrics is reachable from outside"

step "security headers on the page"
headers="$(curl -sI "$BASE/")"
for h in content-security-policy x-content-type-options x-frame-options referrer-policy x-request-id; do
  echo "$headers" | grep -qi "^$h:" || fail "missing header $h"
done

step "owner signs in"
jar="$SMOKE_DIR/owner-cookies"
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -X POST "$BASE/api/auth/sign-in/email" \
  -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")"
[ "$code" = 200 ] || fail "owner sign-in returned $code"
role="$(curl -s -b "$jar" "$BASE/api/me" | json "d['user']['role']")"
[ "$role" = owner ] || fail "expected role owner, got $role"

step "public availability and a client booking"
service="$(curl -s "$BASE/api/services" | json "d['services'][0]['id']")"
staff="$(curl -s "$BASE/api/staff" | json "d['staff'][0]['id']")"
slot=""
for day in $(seq 2 14); do
  date="$(date -u -d "+$day day" +%F)"
  slot="$(curl -s "$BASE/api/availability?serviceIds=$service&staffId=$staff&date=$date" | json "(d['slots'] or [{'startsAt':''}])[0]['startsAt']")"
  [ -n "$slot" ] && break
done
[ -n "$slot" ] || fail "no availability found"
cjar="$SMOKE_DIR/client-cookies"
curl -s -o /dev/null -c "$cjar" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
  -d '{"email":"smoke-client@example.com","name":"Smoke Client","password":"a smoke client passphrase"}'
status="$(curl -s -o "$SMOKE_DIR/booking.json" -w '%{http_code}' -b "$cjar" -X POST "$BASE/api/appointments" \
  -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
  -d "{\"staffId\":\"$staff\",\"serviceIds\":[\"$service\"],\"startsAt\":\"$slot\"}")"
[ "$status" = 201 ] || fail "booking returned $status: $(cat "$SMOKE_DIR/booking.json")"
status="$(curl -s -o /dev/null -w '%{http_code}' -b "$cjar" -X POST "$BASE/api/appointments" \
  -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
  -d "{\"staffId\":\"$staff\",\"serviceIds\":[\"$service\"],\"startsAt\":\"$slot\"}")"
[ "$status" = 409 ] || fail "booking the same slot again returned $status, expected 409"

step "the page renders"
curl -s "$BASE/book" | grep -q "<html" || fail "/book did not render"

step "containers run as non-root with a read-only root filesystem"
for svc in api web worker; do
  cid="$("${COMPOSE[@]}" ps -q "$svc")"
  user="$(docker inspect -f '{{.Config.User}}' "$cid")"; ro="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")"
  echo "$svc user=${user:-root} readonly=$ro"
  [ -n "$user" ] && [ "$user" != root ] && [ "$user" != 0 ] && [ "${user%%:*}" != 0 ] || fail "$svc runs as root"
  [ "$ro" = true ] || fail "$svc root filesystem is writable"
done

echo; echo "SMOKE OK"
