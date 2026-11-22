#!/usr/bin/env bash
# End-to-end smoke test of compose.prod.yaml: builds and starts the stack, creates the owner,
# loads the demo catalogue, then drives it through the reverse proxy like a visitor would:
# readiness, owner sign-in, public availability, a client signing up and booking. Tears
# everything down (including volumes) at the end.
#
#   scripts/smoke-prod.sh            # uses Caddy on http://localhost:8088 (profile tls, SITE_ADDRESS=:80)
#   SMOKE_EMAIL=1 scripts/smoke-prod.sh  # adds a private SMTP sink to the disposable project
#   SMOKE_UPGRADE=1 scripts/smoke-prod.sh  # exercises migration failure and recovery
#   SMOKE_RESTORE=1 scripts/smoke-prod.sh  # backs up, restores and switches the isolated stack
set -euo pipefail
cd "$(dirname "$0")/.."

# Never reuse a deployment's project, volumes, images or .env during a destructive smoke run.
SMOKE_PROJECT="sob-smoke-$(openssl rand -hex 8)"
SMOKE_DIR="$(mktemp -d)"
export SOB_TAG="$SMOKE_PROJECT"
export SOB_API_IMAGE="sob-api:$SOB_TAG" SOB_WEB_IMAGE="sob-web:$SOB_TAG"
export POSTGRES_PASSWORD="smoke-$(openssl rand -hex 8)"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export PUBLIC_URL="http://localhost:8088"
export SOB_DATABASE_NAME=sob VALKEY_KEY_PREFIX=sob:
export SYNC_REPLICA_GENERATION=initial
export SITE_ADDRESS=":80" CADDY_HTTP_PORT=127.0.0.1:8088 CADDY_HTTPS_PORT=127.0.0.1:8443
export WEB_PUBLISH="127.0.0.1:0"
# Caddy (profile tls) is the trusted edge in front of web.
export WEB_TRUST_PROXY=true
# The smoke environment has no mail server: opt out of verification explicitly (production
# refuses to start with verification required and no provider, see ADR 0011).
export AUTH_REQUIRE_EMAIL_VERIFICATION=false NOTIFY_EMAIL_PROVIDER=none NOTIFY_SMS_PROVIDER=none PAYMENT_PROVIDER=none REDSYS_RECURRING_ENABLED=false
export SMTP_URL="" SMTP_URL_FILE="" NOTIFY_EMAIL_FROM="Citame Smoke <smoke-sender@example.com>" NOTIFY_DEFAULT_LOCALE=en
export META_WHATSAPP_APP_ID="" META_WHATSAPP_CONFIG_ID="" META_WHATSAPP_APP_SECRET="" META_WHATSAPP_VERIFY_TOKEN=""
export META_WHATSAPP_APP_SECRET_FILE="" META_WHATSAPP_VERIFY_TOKEN_FILE=""
export MCP_RESOURCE_URL="" MCP_ALLOWED_ORIGINS=""
export OWNER_EMAIL=smoke-owner@example.com OWNER_PASSWORD="smoke passphrase $(openssl rand -hex 4)"
COMPOSE=(docker compose --project-name "$SMOKE_PROJECT" --env-file /dev/null -f compose.prod.yaml --profile tls)
smoke_overlays=()
upgrade_images=()
BASE="$PUBLIC_URL"

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if (( ${#upgrade_images[@]} )); then
    docker image rm "${upgrade_images[@]}" >/dev/null 2>&1 || true
  fi
  docker image rm "sob-api:$SOB_TAG" "sob-web:$SOB_TAG" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

if [ "${SMOKE_EMAIL:-0}" = 1 ]; then
  export NOTIFY_EMAIL_PROVIDER=smtp SMTP_URL=smtp://mailpit:1025
  cat > "$SMOKE_DIR/mail.yaml" <<'YAML'
services:
  mailpit:
    image: axllent/mailpit:v1.29
YAML
  smoke_overlays+=(-f "$SMOKE_DIR/mail.yaml")
fi
if [ "${SMOKE_DESKTOP:-0}" = 1 ]; then
  # All synthetic replicas share one loopback address and replay in a burst.
  cat > "$SMOKE_DIR/desktop-limits.yaml" <<'YAML'
services:
  api:
    environment:
      RATE_LIMIT_GLOBAL_MAX: "1500"
      RATE_LIMIT_AUTH_MAX: "90"
      RATE_LIMIT_OAUTH_MAX: "360"
YAML
  smoke_overlays+=(-f "$SMOKE_DIR/desktop-limits.yaml")
fi
COMPOSE+=("${smoke_overlays[@]}")

step() { printf '\n== %s\n' "$*"; }
fail() { echo "SMOKE FAILED: $*" >&2; "${COMPOSE[@]}" logs --tail 40 >&2 || true; exit 1; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

desktop_tests() (
  cd apps/desktop || exit
  SOB_TEST_API_URL="$BASE" SOB_TEST_REST_PREFIX=/api \
    SOB_TEST_EMAIL="$OWNER_EMAIL" SOB_TEST_PASSWORD="$OWNER_PASSWORD" \
    cargo test -p sob-core --test headless_sync --locked -- --ignored --test-threads=1 "$@"
)

await_public_api() {
  curl -fsS --retry 15 --retry-delay 1 --retry-all-errors --retry-max-time 22 --max-time 3 \
    "$BASE/api/ready" >/dev/null
}

await_http_status() {
  local url="$1" expected="$2" deadline=$((SECONDS + $3)) observed
  while ((SECONDS < deadline)); do
    observed="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$url")" || observed=000
    if [ "$observed" = "$expected" ]; then return 0; fi
    sleep 0.2
  done
  return 1
}

await_mail() {
  "${COMPOSE[@]}" exec -T api bun -e '
    import { strict as assert } from "node:assert";
    const [recipient, prefix, attachmentCount, expectedReviewLink] = Bun.argv.slice(1);
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch("http://mailpit:8025/api/v1/messages", {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      if (response?.ok) {
        const { messages } = await response.json();
        const hits = messages.filter((m) => m.Subject.startsWith(prefix) &&
          m.To.some(({ Address }) => Address === recipient));
        if (hits.length) {
          assert.equal(hits.length, 1, "Expected one delivery");
          assert.equal(hits[0].From.Address, "smoke-sender@example.com");
          assert.equal(hits[0].Attachments, Number(attachmentCount));
          if (expectedReviewLink) {
            const part = await fetch(`http://mailpit:8025/view/${hits[0].ID}.html`, {
              signal: AbortSignal.timeout(3000),
            });
            assert.ok(part.ok, "Expected HTML message part");
            const html = await part.text();
            const links = Array.from(html.matchAll(/href="([^"]+)"/g), ([, href]) => new URL(href));
            assert.ok(links.some((link) => link.href === expectedReviewLink), "Review link is missing");
            const origin = new URL(expectedReviewLink).origin;
            assert.ok(
              links.some((link) => link.origin === origin && link.pathname === "/marketing/opt-out"
                && link.searchParams.get("token")?.trim()),
              "The invitation needs a same-origin opt-out link with a token",
            );
          }
          process.exit(0);
        }
      }
      await Bun.sleep(500);
    }
    throw new Error("Expected SMTP message did not arrive in the private sink");
  ' "$@"
}

email_mode() {
  curl -fsS --max-time 8 -b "$jar" -X PUT "$BASE/api/admin/email-delivery" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"revision\":$1,\"settings\":{\"provider\":\"$2\"}}"
}

make_reminder_due() {
  "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -v ON_ERROR_STOP=1 \
    -v appointment_id="$booking_id" -v kind="$1" -qAt <<'SQL'
UPDATE reminder SET scheduled_for=now()
WHERE appointment_id=:'appointment_id'::uuid AND kind=:'kind'
  AND channel='email' AND status='pending' AND scheduled_for>now()
RETURNING kind;
SQL
}

await_reminder_status() {
  local attempt observed
  for ((attempt=0; attempt<30; attempt++)); do
    observed=$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -v ON_ERROR_STOP=1 \
      -v appointment_id="$booking_id" -v kind="$1" -At <<'SQL'
SELECT status || ':' || coalesce(last_error,'') FROM reminder
WHERE appointment_id=:'appointment_id'::uuid AND kind=:'kind' AND channel='email';
SQL
    ) || return 1
    if [ "$observed" = "$2" ]; then return 0; fi
    sleep 1
  done
  return 1
}

step "config"
"${COMPOSE[@]}" config -q

step "build and start (migrations run as a one-shot job first)"
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300 ||
  fail "Compose startup or migration failed"

step "services"
"${COMPOSE[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}'
"${COMPOSE[@]}" ps -a --format '{{.Service}} {{.State}} exit={{.ExitCode}}' | grep -E '^migrate ' || true
worker_health=$("${COMPOSE[@]}" ps --format '{{.Health}}' worker)
[ "$worker_health" = healthy ] || fail "worker is not healthy after Compose startup"

step "web runtime excludes globs and plugins used by the build"
build_packages="$("${COMPOSE[@]}" exec -T web find /app -type f \( \
  -path '*/node_modules/picomatch/package.json' -o \
  -path '*/node_modules/@tanstack/start-plugin-core/package.json' -o \
  -path '*/node_modules/vite/package.json' \) -print -quit)" ||
  fail "could not inspect the web runtime dependency tree"
[ -z "$build_packages" ] || fail "the web runtime included a build-only dependency: $build_packages"

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
desktop_role="$(curl -fsS -b "$jar" "$BASE/me" | json "d['user']['role']")" ||
  fail "desktop session validation failed"
[ "$desktop_role" = owner ] || fail "desktop session resolved to an unexpected role"

step "staff portraits are private until explicitly published and disappear when withdrawn"
portrait_catalog="$(curl -fsS "$BASE/api/staff")"
portrait_staff="$(json "next(s['id'] for s in d['staff'] if s['serviceIds'])" <<<"$portrait_catalog")"
portrait_service="$(json "next(s['serviceIds'][0] for s in d['staff'] if s['serviceIds'])" <<<"$portrait_catalog")"
smoke_jpeg_base64="$(cd apps/api && bun -e 'import sharp from "sharp"; console.log((await sharp({create:{width:24,height:24,channels:3,background:"#87556a"}}).jpeg().toBuffer()).toString("base64"));')"
portrait_admin="$BASE/api/admin/staff/$portrait_staff/portrait"
portrait_public="$BASE/api/staff/$portrait_staff/portrait"
put_versioned_image() {
  curl -fsS -b "$jar" -X PUT "$1" -H "origin: $PUBLIC_URL" \
    -H 'content-type: application/json' -d "$2" | json "d['version']"
}
private_version="$(put_versioned_image "$portrait_admin" "{\"version\":null,\"imageBase64\":\"$smoke_jpeg_base64\"}")"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$portrait_public/$private_version")" = 404 ] ||
  fail "New portrait was exposed without publication"
public_version="$(put_versioned_image "$portrait_admin/publication" "{\"version\":\"$private_version\",\"published\":true}")"
curl -fsS -D "$SMOKE_DIR/portrait.headers" -o "$SMOKE_DIR/portrait.jpg" "$portrait_public/$public_version" ||
  fail "Published portrait was not served"
grep -qi '^content-type: image/jpeg' "$SMOKE_DIR/portrait.headers" &&
  grep -qi '^cache-control: .*no-store' "$SMOKE_DIR/portrait.headers" || fail "Portrait response headers"
curl -fsS "$BASE/book/professional?services=$portrait_service" -o "$SMOKE_DIR/portrait-booking.html"
grep -Fq "/api/staff/$portrait_staff/portrait/$public_version" "$SMOKE_DIR/portrait-booking.html" ||
  fail "Public booking did not render the published portrait"
put_versioned_image "$portrait_admin/publication" "{\"version\":\"$public_version\",\"published\":false}" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$portrait_public/$public_version")" = 404 ] ||
  fail "Withdrawn portrait remained public"

set_online_booking() {
  curl -fsS -b "$jar" -X PATCH "$BASE/api/admin/settings" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"onlineBookingEnabled\":$1}" >/dev/null ||
    fail "Could not change online booking availability"
}

step "online booking can be paused at the public page and embedded widget"
for enabled in false true; do
  set_online_booking "$enabled"
  for path in book widget; do
    body="$(curl -fsS -H 'Accept-Language: en' "$BASE/$path")" ||
      fail "Could not open /$path"
    if [ "$enabled" = false ]; then
      grep -q "Online booking is paused" <<<"$body" || fail "/$path did not show the pause"
    elif grep -q "Online booking is paused" <<<"$body"; then
      fail "/$path remained paused after reopening"
    fi
  done
done

step "appointment email starts with the server configuration"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/email-delivery")" = 401 ] ||
  fail "Email delivery settings are reachable without a session"
email_delivery="$(curl -fsS -b "$jar" "$BASE/api/admin/email-delivery")"
[ "$(json "d['settings']['provider']" <<<"$email_delivery")" = inherit ] ||
  fail "Appointment email overrides the server configuration on fresh installations"

step "MCP challenges unauthenticated hosts and advertises management scopes"
curl -s -D "$SMOKE_DIR/mcp.headers" -o /dev/null "$BASE/mcp"
grep -qi '^www-authenticate: Bearer .*resource_metadata=' "$SMOKE_DIR/mcp.headers" ||
  fail "MCP did not advertise OAuth discovery"
mcp_scope="$(curl -fsS "$BASE/.well-known/oauth-protected-resource/mcp" |
  json "{'schedule:write', 'billing:write'} <= set(d['scopes_supported'])")"
[ "$mcp_scope" = True ] || fail "MCP management scopes did not reach protected-resource discovery"
mcp_origin_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Origin: https://untrusted.example' "$BASE/mcp")"
[ "$mcp_origin_code" = 403 ] || fail "MCP accepted an unconfigured browser origin through the proxy"

step "owner WhatsApp settings and isolated Meta popup policy"
whatsapp_headers="$(curl -fsS -b "$jar" -D - -o /dev/null "$BASE/admin/whatsapp")"
echo "$whatsapp_headers" | grep -qi '^cross-origin-opener-policy: same-origin-allow-popups' ||
  fail "WhatsApp settings cannot open a Meta popup"
echo "$whatsapp_headers" | grep -qi '^content-security-policy: .*https://connect.facebook.net' ||
  fail "WhatsApp settings do not allow the Meta SDK"
if echo "$headers" | grep -qi 'connect.facebook.net'; then
  fail "the Meta SDK policy leaked to a public page"
fi
whatsapp_status="$(curl -fsS -b "$jar" "$BASE/api/admin/whatsapp" | json "d['connection'] is None")"
[ "$whatsapp_status" = True ] || fail "an unconfigured smoke installation shows a connected sender"

step "public availability and a client booking"
service="$(curl -s "$BASE/api/services" | json "d['services'][0]['id']")"
staff="$(curl -s "$BASE/api/staff" | json "d['staff'][0]['id']")"
if [ "${SMOKE_RESTORE:-0}" = 1 ]; then
  resource="$(curl -fsS -b "$jar" -X POST "$BASE/api/admin/resources" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d '{"name":"Synthetic recovery equipment","kind":"equipment","capacity":1,"idempotencyKey":"smoke-recovery-equipment"}' |
    json "d['id']")" || fail "could not create the synthetic resource"
  resource_version="$(curl -fsS -b "$jar" "$BASE/api/admin/services/$service/resources" |
    json "d['version']")" || fail "could not read the service resource version"
  curl -fsS -b "$jar" -X PUT "$BASE/api/admin/services/$service/resources" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"version\":$resource_version,\"requirements\":[{\"resourceId\":\"$resource\",\"quantity\":1}]}" \
    >/dev/null || fail "could not require the resource for the synthetic booking"
fi
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
booking_id="$(json "d['id']" < "$SMOKE_DIR/booking.json")"
status="$(curl -s -o /dev/null -w '%{http_code}' -b "$cjar" -X POST "$BASE/api/appointments" \
  -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
  -d "{\"staffId\":\"$staff\",\"serviceIds\":[\"$service\"],\"startsAt\":\"$slot\"}")"
[ "$status" = 409 ] || fail "booking the same slot again returned $status, expected 409"

step "the public booking pause blocks a customer series that was reviewed before it"
series_input="{\"staffId\":\"$staff\",\"serviceIds\":[\"$service\"],\"startsAt\":\"$slot\",\"cadence\":\"weekly\",\"interval\":1,\"count\":2}"
series_hash="$(curl -fsS -b "$cjar" -X POST "$BASE/api/appointments/series/preview" \
  -H 'content-type: application/json' -H "origin: $PUBLIC_URL" -d "$series_input" |
  json "d['reviewHash']")" || fail "Could not review a customer series"
series_request="${series_input%\}},\"reviewHash\":\"$series_hash\",\"idempotencyKey\":\"smoke-series-pause\"}"
set_online_booking false
for action in preview create; do
  if [ "$action" = preview ]; then
    series_path=series/preview
    series_body="$series_input"
  else
    series_path=series
    series_body="$series_request"
  fi
  status="$(curl -sS -o "$SMOKE_DIR/paused-series.json" -w '%{http_code}' -b "$cjar" \
    -X POST "$BASE/api/appointments/$series_path" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" -d "$series_body")"
  [ "$status" = 409 ] &&
    [ "$(json "d['error']['code']" < "$SMOKE_DIR/paused-series.json")" = online_booking_paused ] ||
    fail "Paused customer series $action returned $status or the wrong error"
done
set_online_booking true

step "inventory stores a private versioned product photo through the production proxy"
product_url="$BASE/api/admin/inventory/products"
product_id="$(curl -fsS -b "$jar" -X POST "$product_url" \
  -H "origin: $PUBLIC_URL" -H 'content-type: application/json' \
  -d '{"name":"Smoke shampoo","sku":"SMOKE-PHOTO","priceCents":2000,"idempotencyKey":"smoke-product-photo-v1"}' |
  json "d['id']")" ||
  fail "Could not create a synthetic inventory product"
product_photo="$product_url/$product_id/photo"
photo_version="$(put_versioned_image "$product_photo" "{\"version\":null,\"imageBase64\":\"$smoke_jpeg_base64\"}")" ||
  fail "Could not upload an inventory photo"
curl -fsS -b "$jar" -D "$SMOKE_DIR/product.headers" -o "$SMOKE_DIR/product.jpg" \
  "$product_photo/$photo_version" || fail "Owner could not read the saved product photo"
grep -qi '^content-type: image/jpeg' "$SMOKE_DIR/product.headers" &&
  grep -qi '^cache-control: private, no-store' "$SMOKE_DIR/product.headers" ||
  fail "Product photo was not served with private JPEG headers"
[ -s "$SMOKE_DIR/product.jpg" ] || fail "Product photo response was empty"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$product_photo/$photo_version")" = 401 ] ||
  fail "An anonymous visitor could read the product photo"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$cjar" "$product_photo/$photo_version")" = 403 ] ||
  fail "A customer could read the product photo"
put_versioned_image "$product_photo" "{\"version\":\"$photo_version\",\"imageBase64\":null}" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$product_photo/$photo_version")" = 404 ] ||
  fail "The old product photo URL remained valid after removal"

if [ "${SMOKE_EMAIL:-0}" = 1 ]; then
  step "owner email test, appointment confirmation and live reminder delivery"
  await_mail smoke-client@example.com 'Appointment confirmed:' 1 || fail "SMTP confirmation"
  if [ "${SMOKE_DESKTOP:-0}" = 1 ]; then
    desktop_tests native_sends_a_reviewed_email_test_through_the_proxy --exact ||
      fail "native owner SMTP test"
  else
    curl -fsS --max-time 8 -b "$jar" -X POST -H "origin: $PUBLIC_URL" \
      -H 'content-type: application/json' -d '{"revision":null}' \
      "$BASE/api/admin/email-delivery/test-reviewed" >/dev/null || fail "owner SMTP test"
  fi
  await_mail "$OWNER_EMAIL" 'Citame · Prueba de correo' 0 || fail "owner test delivery"

  disabled=$(email_mode null disabled) || fail "disable appointment email"
  revision=$(json "json.dumps(d['revision'])" <<<"$disabled")
  [[ "$(make_reminder_due reminder_24h)" == reminder_24h ]] ||
    fail "expected a pending first reminder"
  await_reminder_status reminder_24h skipped:channel_disabled || fail "worker kept email enabled"
  email_mode "$revision" inherit >/dev/null || fail "restore server email settings"
  [[ "$(make_reminder_due reminder_2h)" == reminder_2h ]] ||
    fail "expected a pending second reminder"
  await_reminder_status reminder_2h sent: || fail "worker did not resume email"
  await_mail smoke-client@example.com 'Reminder: your appointment is today,' 0 ||
    fail "SMTP reminder delivery"
fi

step "seed cancelled, missed and completed visits alongside the live booking"
outcomes="$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAt -v ON_ERROR_STOP=1 \
  -v booking_id="$booking_id" <<'SQL'
WITH source AS (
  SELECT staff_id, client_id, ends_at - starts_at AS duration,
         (SELECT timezone FROM salon_settings LIMIT 1) AS timezone
  FROM appointment WHERE id = :'booking_id'::uuid
), new_profile AS (
  INSERT INTO client_profile (id, name) VALUES (uuidv7(), 'Smoke new report client')
  RETURNING id
), outcomes AS (
  INSERT INTO appointment (id, staff_id, client_id, starts_at, ends_at, status)
  SELECT uuidv7(), staff_id, CASE WHEN first_visit THEN new_profile.id ELSE client_id END,
         begins, begins + duration, kind::appointment_status
  FROM source CROSS JOIN new_profile CROSS JOIN (
    VALUES ('cancelled', 2, 9, false), ('no_show', 2, 11, false),
           ('completed', 2, 13, false), ('completed', 2, 15, true), ('completed', 3, 13, false)
  ) AS scenario(kind, days_ago, local_hour, first_visit)
  CROSS JOIN LATERAL (
    SELECT ((now() AT TIME ZONE timezone)::date - days_ago
            + local_hour * interval '1 hour') AT TIME ZONE timezone AS begins
  ) AS slot
  RETURNING id, starts_at, status
), lines AS (
  INSERT INTO appointment_service (
    id, appointment_id, service_id, position, name, duration_minutes, buffer_minutes, price_cents, currency
  )
  SELECT uuidv7(), outcomes.id, snapshot.service_id, snapshot.position, snapshot.name, snapshot.duration_minutes,
         snapshot.buffer_minutes, snapshot.price_cents, snapshot.currency
  FROM outcomes CROSS JOIN appointment_service snapshot
  WHERE snapshot.appointment_id = :'booking_id'::uuid
  RETURNING appointment_id
)
SELECT jsonb_build_object(
  'date', min((starts_at AT TIME ZONE (SELECT timezone FROM salon_settings LIMIT 1))::date),
  'ids', jsonb_object_agg(status::text, id)
)
FROM outcomes WHERE status IN ('cancelled', 'no_show')
AND EXISTS (SELECT 1 FROM lines WHERE lines.appointment_id = outcomes.id);
SQL
)" || fail "could not seed the synthetic report rows"

if [ "${SMOKE_EMAIL:-0}" = 1 ]; then
  step "a review email is delivered once by the standalone worker"
  review_client="$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAt -v ON_ERROR_STOP=1 \
    -v booking_id="$booking_id" <<'SQL'
UPDATE "user" AS account SET email_verified = true
FROM client_profile AS profile JOIN appointment AS visit ON visit.client_id = profile.id
WHERE visit.id = :'booking_id'::uuid AND account.id = profile.user_id
RETURNING profile.id;
SQL
  )" || fail "could not verify the synthetic client email"
  [ -n "$review_client" ] || fail "no synthetic client account was verified"
  review_requests="$BASE/api/admin/reviews/requests?search=Smoke%20Client"
  curl -fsS -b "$jar" -X PATCH "$BASE/api/admin/clients/$review_client/marketing-consent" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d '{"channel":"email","enabled":true,"version":0,"source":"Synthetic smoke consent"}' >/dev/null ||
    fail "could not enable commercial email for the synthetic client"
  review_appointment_id="$(curl -fsS -b "$jar" "$review_requests" |
    json "next(v['appointmentId'] for v in d['visits'] if v['canEmail'])")" ||
    fail "no completed synthetic visit was eligible for email"
  review_email="$BASE/api/admin/reviews/requests/$review_appointment_id/email"
  review_link="$BASE/account/reviews?appointmentId=$review_appointment_id"
  if [ "${SMOKE_DESKTOP:-0}" = 1 ]; then
    SOB_TEST_REVIEW_APPOINTMENT="$review_appointment_id" \
      desktop_tests native_review_requests_queue_and_replay_a_real_invitation_through_the_proxy --exact ||
      fail "the native client could not queue and replay the review invitation"
  else
    curl -fsS -b "$jar" -X POST "$review_email" \
      -H 'content-type: application/json' -H "origin: $PUBLIC_URL" -d '{}' >/dev/null ||
      fail "review email queue rejected the request"
  fi
  await_mail smoke-client@example.com 'How was your visit to ' 0 "$review_link" ||
    fail "SMTP review invitation delivery"
  review_status=""
  for _ in {1..20}; do
    review_status="$(curl -fsS --max-time 3 -b "$jar" "$review_requests" |
      json "next(v['emailStatus'] for v in d['visits'] if v['link'] == '$review_link')")" ||
      fail "could not read the review invitation status"
    [ "$review_status" != sent ] || break
    sleep 0.25
  done
  [ "$review_status" = sent ] || fail "review invitation status was $review_status"
  replay_status="$(curl -fsS -b "$jar" -X POST "$review_email" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" -d '{}' |
    json "d['status']")" || fail "review email queue rejected the replay"
  [ "$replay_status" = sent ] || fail "replay replaced the sent review invitation"
  review_replayed_at=$SECONDS
  review_deliveries="$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAt -v ON_ERROR_STOP=1 \
    -v client_id="$review_client" <<'SQL'
SELECT count(*)
FROM marketing_delivery AS delivery JOIN marketing_campaign AS campaign ON campaign.id = delivery.campaign_id
WHERE delivery.client_id = :'client_id'::uuid AND campaign.purpose = 'review_request';
SQL
  )" || fail "could not count review deliveries"
  [ "$review_deliveries" = 1 ] || fail "replay created $review_deliveries review deliveries"
fi

step "MCP OAuth and persistent desktop devices authorize, sync, export reports and revoke access"
bun scripts/smoke-oauth.ts "$jar" "$booking_id" "$slot" "$cjar" "$outcomes" ||
  fail "MCP or desktop OAuth flow through the proxy"

step "the new booking reaches the owner calendar and desktop replica"
curl -fsS -b "$jar" -D "$SMOKE_DIR/calendar.headers" -o "$SMOKE_DIR/calendar.html" \
  "$BASE/admin/calendar?date=$date&view=day" || fail "authenticated calendar did not render"
grep -qi '^cache-control: private, no-store' "$SMOKE_DIR/calendar.headers" ||
  fail "authenticated calendar cache policy is not private"
python3 - "$SMOKE_DIR/calendar.html" <<'PY' || fail "the new booking was missing from the first calendar HTML"
import sys
from html.parser import HTMLParser

class Cards(HTMLParser):
    found = False

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "button" and attrs.get("data-status") == "booked":
            self.found |= " · Smoke Client · " in attrs.get("title", "")

cards = Cards()
with open(sys.argv[1], encoding="utf-8") as page:
    cards.feed(page.read())
assert cards.found
PY
curl -fsS -b "$jar" "$BASE/api/sync/pull?since=0&limit=500" > "$SMOKE_DIR/sync.json" ||
  fail "desktop replica pull failed"
python3 - "$SMOKE_DIR/sync.json" "$booking_id" <<'PY' || fail "booking missing from desktop replica"
import json, sys
with open(sys.argv[1]) as source:
    response = json.load(source)
assert any(row["entity"] == "appointment" and row["id"] == sys.argv[2]
           for row in response["changes"])
PY
status="$(curl -s -o /dev/null -w '%{http_code}' -b "$cjar" "$BASE/sync/pull?since=0&limit=1")"
[ "$status" = 403 ] || fail "customer account was able to read the staff replica"
step "the web gateway restarts cleanly with the staff stream open"
curl -fsN --max-time 25 -b "$jar" "$BASE/api/sync/stream" > "$SMOKE_DIR/events" &
stream_pid=$!
for _ in {1..50}; do
  grep -q '^event: change' "$SMOKE_DIR/events" && break
  kill -0 "$stream_pid" 2>/dev/null || fail "staff stream request exited before its first event"
  sleep 0.1
done
grep -q '^event: change' "$SMOKE_DIR/events" || fail "no live change event through the proxy"
web_id="$("${COMPOSE[@]}" ps -q web)"
"${COMPOSE[@]}" stop --timeout 12 web || fail "web gateway did not stop"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$web_id")" = 0 ] ||
  fail "web gateway required forced termination with a staff stream open"
wait "$stream_pid" || fail "the open staff stream did not close cleanly"
await_http_status "$BASE/healthz" 503 14 ||
  fail "the proxy did not mark the stopped web gateway unavailable"
# Restart only the gateway so this test keeps the original API and database running.
docker start "$web_id" >/dev/null || fail "web gateway did not restart"
web_address="$("${COMPOSE[@]}" port web 4173)" || fail "web gateway has no loopback port"
await_http_status "http://$web_address/healthz" 200 12 ||
  fail "the restarted web gateway did not become healthy on loopback"
proxy_ready_start=$SECONDS
await_http_status "$BASE/healthz" 200 5 ||
  fail "the proxy took too long to route to the healthy web gateway"
echo "Proxy routed to the healthy web gateway after $((SECONDS - proxy_ready_start))s"
stream_status=0
curl -fsN --max-time 3 -b "$jar" "$BASE/sync/stream" > "$SMOKE_DIR/reconnected-events" ||
  stream_status=$?
[ "$stream_status" = 0 ] || [ "$stream_status" = 28 ] || fail "reconnecting the desktop stream failed"
grep -q '^event: change' "$SMOKE_DIR/reconnected-events" || fail "no live event after reconnect"

if [ "${SMOKE_DESKTOP:-0}" = 1 ]; then
  step "desktop offline replay against the production proxy"
  moderation_visit="$(curl -fsS -b "$jar" "$BASE/api/admin/reviews/requests?search=Smoke%20Client" |
    json "next(v['appointmentId'] for v in d['visits'] if v['appointmentId'] != '${review_appointment_id:-}')")" ||
    fail "no synthetic review visit for desktop moderation"
  review_key="$(bun -e 'console.log(Bun.randomUUIDv7())')"
  managed_review_id="$(curl -fsS -b "$cjar" -X POST "$BASE/api/me/reviews" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"appointmentId\":\"$moderation_visit\",\"idempotencyKey\":\"$review_key\",\"publicName\":\"Synthetic client\",\"rating\":4,\"body\":\"Synthetic desktop review\",\"publicationConfirmed\":true}" |
    json "d['id']")" || fail "could not create the synthetic review"
  imported_waitlist_id="$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAt \
    -v ON_ERROR_STOP=1 <<'SQL'
WITH customer AS (
  INSERT INTO client_profile (id, name) VALUES (uuidv7(), 'Synthetic waitlist import') RETURNING id
)
INSERT INTO waitlist_source_entry (
  id, client_id, requested_date, duration_minutes, flexible, source_order, source_hash, captured_at
)
SELECT uuidv7(), customer.id, (now() AT TIME ZONE settings.timezone)::date + 21,
  service.duration_minutes + service.buffer_minutes, false, 0, 'synthetic-smoke', now()
FROM customer CROSS JOIN salon_settings settings CROSS JOIN service
WHERE settings.id = 1 AND service.name = 'Haircut' AND service.deleted_at IS NULL
RETURNING waitlist_source_entry.id;
SQL
  )" || fail "could not create the synthetic imported waitlist request"
  [[ "$imported_waitlist_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] ||
    fail "expected exactly one synthetic imported waitlist request"
  "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -v ON_ERROR_STOP=1 -q \
    -v booking_id="$booking_id" <<'SQL'
INSERT INTO whatsapp_connection (waba_id, phone_id, phone, coexistence, encrypted_token, rules)
VALUES ('111110', '111111', '+34 611 000 000', true, 'synthetic-non-credential',
  '[{"kind":"confirmation","templateId":"111112","variables":[],"template":{"id":"111112","name":"smoke_confirmation","language":"es_ES","body":"Synthetic","parameters":[],"named":false}}]'::jsonb);
INSERT INTO reminder (id, appointment_id, kind, channel, appointment_version, scheduled_for, status, whatsapp_delivery)
SELECT uuidv7(), id, 'confirmation', 'whatsapp', version, now(), 'sent', 'read'
FROM appointment WHERE id = :'booking_id'::uuid;
WITH reviewed_account AS (
  INSERT INTO "user" (id, name, email, email_verified)
  VALUES (uuidv7()::text, 'Synthetic role review', 'smoke-role-review@example.test', true)
  RETURNING id, name, email
)
INSERT INTO client_profile (id, user_id, name, email)
SELECT uuidv7(), id, name, email FROM reviewed_account;
SQL
  # Suspend the existing worker while testing synthetic SMTP settings.
  worker_id="$("${COMPOSE[@]}" ps -q worker)"
  "${COMPOSE[@]}" stop worker || fail "stop the synthetic delivery worker"
  desktop_tests native_email_delivery_uses_the_owner_revision_through_the_proxy --exact ||
    fail "native email settings integration failed"
  docker start "$worker_id" >/dev/null || fail "restart the synthetic delivery worker"
  SOB_TEST_UNLINKED_ACCOUNT_EMAIL="smoke-role-review@example.test" \
    desktop_tests native_unlinked_account_review_through_the_proxy --exact ||
    fail "native reviewed account integration failed"
  SOB_TEST_MANAGED_REVIEW="$managed_review_id" SOB_TEST_INVENTORY_PRODUCT="$product_id" \
    SOB_TEST_IMPORTED_WAITLIST="$imported_waitlist_id" \
    desktop_tests --skip native_review_requests --skip native_sends_a_reviewed_email_test \
      --skip native_email_delivery_uses_the_owner_revision \
      --skip native_unlinked_account_review_through_the_proxy || fail "desktop integration tests failed"
fi

step "the page renders"
curl -fsS --retry 1 --retry-max-time 20 --max-time 5 -o "$SMOKE_DIR/book.html" "$BASE/book" ||
  fail "/book did not return a successful response"
grep -q "<html" "$SMOKE_DIR/book.html" || fail "/book did not return HTML"

if [ "${SMOKE_UPGRADE:-0}" = 1 ]; then
  step "online migration rejects the real pre-0061 schema"
  cp -R packages/db/drizzle "$SMOKE_DIR/pre-live-view"
  python3 - "$SMOKE_DIR/pre-live-view/meta/_journal.json" <<'PY'
import json, sys
from pathlib import Path
file = Path(sys.argv[1])
journal = json.loads(file.read_text())
index = next(i for i, migration in enumerate(journal["entries"])
             if migration["tag"] == "0061_live_view_changes")
journal["entries"] = journal["entries"][:index]
file.write_text(json.dumps(journal))
PY
  "${COMPOSE[@]}" exec -T postgres createdb -U sob sob_upgrade_0060
  old_target=(-e "DATABASE_URL=postgres://sob:$POSTGRES_PASSWORD@postgres:5432/sob_upgrade_0060")
  "${COMPOSE[@]}" run --rm --no-deps -T "${old_target[@]}" \
    -v "$SMOKE_DIR/pre-live-view:/app/packages/db/drizzle:ro" migrate
  schema_has_live_views() {
    "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob_upgrade_0060 -qAtc \
      "SELECT to_regprocedure('public.sync_record_live_view()') IS NOT NULL"
  }
  [ "$(schema_has_live_views)" = f ] || fail "pre-0061 fixture already had live-view triggers"
  if "${COMPOSE[@]}" run --rm --no-deps -T "${old_target[@]}" migrate \
    bun packages/db/src/scripts/migrate.ts --online > "$SMOKE_DIR/upgrade-guard.log" 2>&1; then
    fail "the pre-0061 database accepted an online upgrade"
  fi
  grep -q "requires a maintenance upgrade" "$SMOKE_DIR/upgrade-guard.log" ||
    fail "the pre-0061 online upgrade was rejected for the wrong reason"
  [ "$(schema_has_live_views)" = f ] || fail "the rejected upgrade changed the pre-0061 database"
  "${COMPOSE[@]}" run --rm --no-deps -T "${old_target[@]}" migrate
  [ "$(schema_has_live_views)" = t ] || fail "offline migration did not apply 0061"
  "${COMPOSE[@]}" run --rm --no-deps -T "${old_target[@]}" migrate \
    bun packages/db/src/scripts/migrate.ts --online

  step "a failed migration rolls back while the running agenda stays available"
  cp -R packages/db/drizzle "$SMOKE_DIR/upgrade-migrations"
  python3 - "$SMOKE_DIR/upgrade-migrations/meta/_journal.json" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
journal = json.loads(path.read_text())
last = journal["entries"][-1]
journal["entries"].append(dict(last, idx=last["idx"] + 1, when=last["when"] + 1,
                               tag="smoke_upgrade_probe", breakpoints=True))
path.write_text(json.dumps(journal))
PY
  smoke_migration="$SMOKE_DIR/upgrade-migrations/smoke_upgrade_probe.sql"
  printf '%s\n' 'CREATE TABLE public.smoke_upgrade_probe (id integer primary key);' \
    '--> statement-breakpoint' 'SELECT 1 / 0;' > "$smoke_migration"
  cat > "$SMOKE_DIR/upgrade.yaml" <<YAML
services:
  migrate:
    volumes:
      - "$SMOKE_DIR/upgrade-migrations:/app/packages/db/drizzle:ro"
YAML
  release_args=(--project-name "$SMOKE_PROJECT" --env-file /dev/null --profile tls)
  release_args+=("${smoke_overlays[@]}")
  upgrade_args=("${release_args[@]}" -f "$SMOKE_DIR/upgrade.yaml")
  services_before=$("${COMPOSE[@]}" ps -q api worker web | sort)
  caddy_before=$("${COMPOSE[@]}" ps -q caddy)
  declare -A service_before
  for svc in api worker web; do
    service_before["$svc"]=$("${COMPOSE[@]}" ps -q "$svc")
    [ -n "${service_before[$svc]}" ] || fail "missing $svc before upgrade"
  done
  [ -n "$caddy_before" ] || fail "missing proxy before upgrade"
  booked_row() {
    "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAt -v ON_ERROR_STOP=1 \
      -v booking_id="$booking_id" <<'SQL'
SELECT id, staff_id, starts_at, status, version FROM appointment WHERE id=:'booking_id'::uuid;
SQL
  }
  booked_before=$(booked_row)
  [ -n "$booked_before" ] || fail "missing synthetic booking before upgrade"
  if bash scripts/upgrade-prod.sh --prebuilt "${upgrade_args[@]}" > "$SMOKE_DIR/upgrade-failed.log" 2>&1; then
    fail "an invalid migration reached service replacement"
  fi
  grep -qi 'division by zero' "$SMOKE_DIR/upgrade-failed.log" || fail "migration failed for the wrong reason"
  [ "$services_before" = "$("${COMPOSE[@]}" ps -q api worker web | sort)" ] ||
    fail "the failed migration replaced a running service"
  [ "$caddy_before" = "$("${COMPOSE[@]}" ps -q caddy)" ] ||
    fail "the failed migration replaced the running proxy"
  [ "$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAtc \
    "SELECT to_regclass('public.smoke_upgrade_probe') IS NULL")" = t ] ||
    fail "its schema changes survived a failed migration"
  [ "$booked_before" = "$(booked_row)" ] || fail "the booking changed on migration failure"
  curl -fsS --max-time 3 -b "$jar" "$BASE/api/ready" > /dev/null ||
    fail "the live API stopped responding after the rejected upgrade"

  step "a failed maintenance migration resumes the same API and worker"
  web_started_before=$(docker inspect --format '{{.State.StartedAt}}' "$("${COMPOSE[@]}" ps -q web)")
  if bash scripts/upgrade-prod.sh --prebuilt --maintenance "${upgrade_args[@]}" \
    > "$SMOKE_DIR/upgrade-maintenance-failed.log" 2>&1; then
    fail "an invalid maintenance migration reached service replacement"
  fi
  if ! grep -qi 'division by zero' "$SMOKE_DIR/upgrade-maintenance-failed.log"; then
    tail -n 40 "$SMOKE_DIR/upgrade-maintenance-failed.log" >&2
    fail "maintenance migration failed for the wrong reason"
  fi
  grep -qi 'Restarting the previous API and worker' "$SMOKE_DIR/upgrade-maintenance-failed.log" ||
    fail "maintenance failure did not resume the previous writers"
  [ "$services_before" = "$("${COMPOSE[@]}" ps -q api worker web | sort)" ] ||
    fail "maintenance failure did not restore the same running services"
  [ "$caddy_before" = "$("${COMPOSE[@]}" ps -q caddy)" ] ||
    fail "the failed maintenance migration replaced the running proxy"
  web_started_after=$(docker inspect --format '{{.State.StartedAt}}' "$("${COMPOSE[@]}" ps -q web)")
  if grep -Fq 'Restarting the web gateway to reconnect it to the previous API.' "$SMOKE_DIR/upgrade-maintenance-failed.log"; then
    [ "$web_started_before" != "$web_started_after" ] ||
      fail "the declared gateway restart did not restart the running container"
    if grep -Fq 'The web gateway could not reach the previous API after restart.' "$SMOKE_DIR/upgrade-maintenance-failed.log"; then
      fail "the restarted web gateway could not reach the resumed API"
    fi
    # Caddy keeps its previous health state until its next upstream probe.
    await_http_status "$BASE/api/ready" 200 6 ||
      fail "the resumed API did not become publicly ready after the gateway restart"
    echo "The same gateway container restarted and public readiness recovered"
  else
    [ "$web_started_before" = "$web_started_after" ] ||
      fail "the web gateway restarted outside the documented recovery path"
    if ! readiness_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/api/ready")" ||
      [ "$readiness_status" != 200 ]; then
      fail "the resumed API was not ready through the proxy when the upgrade returned"
    fi
  fi
  [ "$booked_before" = "$(booked_row)" ] || fail "the booking changed on maintenance failure"

  step "maintenance applies an embedded migration and replaces the prebuilt images"
  cat > "$smoke_migration" <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database() AND client_addr IS NOT NULL
      AND client_addr IS DISTINCT FROM inet_client_addr()
      AND backend_type = 'client backend' AND usename = current_user
  ) THEN
    RAISE EXCEPTION 'Application database connections remained open during maintenance';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE public.smoke_upgrade_probe (id integer primary key);
SQL
  upgrade_images=("sob-api:${SOB_TAG}-upgrade" "sob-web:${SOB_TAG}-upgrade")
  prior_api_id=$(docker image inspect --format '{{.Id}}' "$SOB_API_IMAGE")
  prior_web_id=$(docker image inspect --format '{{.Id}}' "$SOB_WEB_IMAGE")
  docker build --pull=false --network=none --tag "${upgrade_images[0]}" -f - \
    "$SMOKE_DIR/upgrade-migrations" <<DOCKERFILE
FROM $SOB_API_IMAGE
COPY --chown=bun:bun . /app/packages/db/drizzle/
DOCKERFILE
  mkdir -p "$SMOKE_DIR/upgrade-web"
  docker build --pull=false --network=none --tag "${upgrade_images[1]}" -f - \
    "$SMOKE_DIR/upgrade-web" <<DOCKERFILE
FROM $SOB_WEB_IMAGE
LABEL citame.smoke.release="$SMOKE_PROJECT"
DOCKERFILE
  export SOB_API_IMAGE="${upgrade_images[0]}" SOB_WEB_IMAGE="${upgrade_images[1]}"
  release_api_id=$(docker image inspect --format '{{.Id}}' "$SOB_API_IMAGE")
  release_web_id=$(docker image inspect --format '{{.Id}}' "$SOB_WEB_IMAGE")
  [ "$release_api_id" != "$prior_api_id" ] && [ "$release_web_id" != "$prior_web_id" ] ||
    fail "the staged release did not contain distinct images"
  step "reject a live Web process with an unreachable API before replacing Caddy"
  cat > "$SMOKE_DIR/broken-web.yaml" <<'YAML'
services:
  web:
    extra_hosts:
      - "api:127.0.0.1"
    healthcheck:
      test: ["CMD", "bun", "-e", "const res = await fetch('http://127.0.0.1:4173/healthz'); process.exit(res.ok ? 0 : 1)"]
YAML
  broken_args=("${release_args[@]}" -f "$SMOKE_DIR/broken-web.yaml")
  if bash scripts/upgrade-prod.sh --prebuilt --maintenance "${broken_args[@]}" > "$SMOKE_DIR/upgrade-web-failed.log" 2>&1; then
    fail "the upgrade succeeded with an unreachable API gateway"
  fi
  grep -Fq "The web gateway could not reach the upgraded API" "$SMOKE_DIR/upgrade-web-failed.log" ||
    fail "the upgrade did not report the failed gateway check"
  [ "$caddy_before" = "$("${COMPOSE[@]}" ps -q caddy)" ] || fail "Caddy changed despite the failed gateway check"
  [ "$booked_before" = "$(booked_row)" ] || fail "the gateway failure changed the booking"
  [ "$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAtc \
    "SELECT to_regclass('public.smoke_upgrade_probe') IS NOT NULL")" = t ] ||
    fail "the gateway failure lost the committed migration"

  step "repair the upgraded gateway and refresh Caddy"
  bash scripts/upgrade-prod.sh --prebuilt "${release_args[@]}" ||
    fail "the corrected gateway upgrade failed"
  for svc in api worker web; do
    replaced=$("${COMPOSE[@]}" ps -q "$svc")
    [ -n "$replaced" ] && [ "$replaced" != "${service_before[$svc]}" ] ||
      fail "the successful upgrade did not replace $svc"
    expected_image="$release_api_id"
    if [ "$svc" = web ]; then expected_image="$release_web_id"; fi
    [ "$(docker inspect --format '{{.Image}}' "$replaced")" = "$expected_image" ] ||
      fail "the successful upgrade did not run the new image for $svc"
  done
  replaced=$("${COMPOSE[@]}" ps -q caddy)
  [ -n "$replaced" ] && [ "$caddy_before" != "$replaced" ] ||
    fail "the supported upgrade left the previous proxy configuration active"
  [ "$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAtc \
    "SELECT to_regclass('public.smoke_upgrade_probe') IS NOT NULL")" = t ] ||
    fail "the new schema did not survive the successful upgrade"
  [ "$booked_before" = "$(booked_row)" ] || fail "the booking changed during upgrade"
  await_public_api || fail "the upgraded API did not come back"
  probe="synthetic-smoke-verify-token-$(openssl rand -hex 8)"
  curl -sS --max-time 3 -o /dev/null \
    "$BASE/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$probe" ||
    fail "the upgraded proxy did not answer the verification request"
  edge_logs=$("${COMPOSE[@]}" logs --no-color caddy)
  grep -Fq 'hub.verify_token=REDACTED' <<<"$edge_logs" ||
    fail "the upgraded proxy did not redact the verification token"
  if grep -Fq "$probe" <<<"$edge_logs"; then fail "the upgraded proxy logged a verification token"; fi


fi

if [ "${SMOKE_RESTORE:-0}" = 1 ]; then
  step "restore the Compose stack into a separate database and switch its services"
  ledger_before=$(curl -fsS --max-time 5 -b "$jar" "$BASE/api/admin/inventory/movements") ||
    fail "could not read the stock ledger before restoring"
  ledger_anchor=$(json "d['anchor']" <<< "$ledger_before") ||
    fail "the stock ledger did not provide a browsing anchor"
  pg_container=$("${COMPOSE[@]}" ps -q postgres)
  [ -n "$pg_container" ] || fail "cannot identify the smoke Postgres container"
  "${COMPOSE[@]}" stop caddy web
  "${COMPOSE[@]}" stop api worker
  recovery_dump="$SMOKE_DIR/recovery.dump"
  PG_MODE=docker PG_CONTAINER="$pg_container" DATABASE_URL=postgres://sob@localhost:5432/sob \
    bash scripts/backup.sh "$recovery_dump" || fail "production stack backup failed"
  recovered_database=sob_recovered
  PG_MODE=docker PG_CONTAINER="$pg_container" \
    bash scripts/restore.sh "$recovery_dump" "postgres://sob@localhost:5432/$recovered_database" ||
    fail "production stack restore failed"
  recovery_booking() {
    "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d "$1" -qAt -v ON_ERROR_STOP=1 \
      -v target_id="$booking_id" <<'SQL'
SELECT jsonb_build_object(
  'appointment', to_jsonb(a),
  'services', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position)
               FROM appointment_service s WHERE s.appointment_id = a.id),
  'staff', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
            FROM staff_reservation s WHERE s.appointment_id = a.id),
  'resources', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
                FROM resource_reservation r WHERE r.appointment_id = a.id)
) FROM appointment a WHERE a.id = :'target_id'::uuid;
SQL
  }
  source_booking=$(recovery_booking sob)
  [ "$(json "bool(d['services'] and d['staff'] and d['resources'])" <<< "$source_booking")" = True ] ||
    fail "the original booking is missing service, staff or equipment allocations"
  [ "$source_booking" = "$(recovery_booking "$recovered_database")" ] ||
    fail "the restored appointment or its allocations do not match the original"
  restored_name=$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d "$recovered_database" -qAtc \
    "SELECT name FROM salon_settings")
  [ -n "$restored_name" ] || fail "the restored salon has no settings"
  # This marker is for the synthetic source database only. It proves the live API switched.
  source_marker="Synthetic source-only name"
  "${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -q -v ON_ERROR_STOP=1 \
    -v source_marker="$source_marker" <<'SQL'
UPDATE salon_settings SET name = :'source_marker';
SQL
  export SOB_DATABASE_NAME="$recovered_database"
  export VALKEY_KEY_PREFIX="sob:smoke-recovery:"
  export SYNC_REPLICA_GENERATION="$SMOKE_PROJECT-recovered"
  "${COMPOSE[@]}" run --rm --no-deps --pull never -T migrate ||
    fail "migrating the restored database failed"
  "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait api ||
    fail "private validation of the restored API failed"
  running_during_recovery=$("${COMPOSE[@]}" ps --quiet --status running worker web caddy) ||
    fail "could not verify private recovery isolation"
  [ -z "$running_during_recovery" ] ||
    fail "the worker or public ingress came up during private recovery validation"
  "${COMPOSE[@]}" exec -T api bun -e \
    'const res = await fetch("http://localhost:3000/ready"); process.exit(res.ok ? 0 : 1)' ||
    fail "the restored API was not ready in private validation"
  "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait worker web ||
    fail "the worker or web gateway could not start on the restored database"
  reopen_ingress=(bun --no-env-file scripts/reopen-recovery-ingress.ts "$BASE" --project-name "$SMOKE_PROJECT"
    --env-file /dev/null "${smoke_overlays[@]}")
  caddy_before_reopening=$("${COMPOSE[@]}" ps --all --quiet caddy)
  if SOB_DATABASE_NAME=sob VALKEY_KEY_PREFIX=sob: SYNC_REPLICA_GENERATION=initial \
    "${reopen_ingress[@]}" > "$SMOKE_DIR/reopen-wrong-recovery-target.log" 2>&1; then
    fail "recovery reopened ingress using the previous deployment settings"
  fi
  grep -q 'Recovery refused: the database, cache namespace or sync generation differs' \
    "$SMOKE_DIR/reopen-wrong-recovery-target.log" ||
    fail "recovery refused the previous deployment settings for the wrong reason"
  [ "$(docker inspect --format '{{.State.Status}}' "$caddy_before_reopening")" = exited ] ||
    fail "refusing stale recovery settings changed the stopped Caddy"
  verify_recovery_reopening() {
    "${reopen_ingress[@]}" || fail "public ingress did not reopen on the $1 database"
    curl -fsS --max-time 5 "$BASE/api/ready" >/dev/null ||
      fail "the $1 API did not answer the first request after reopening"
  }
  verify_recovery_reopening restored
  if SOB_DATABASE_NAME=sob VALKEY_KEY_PREFIX=sob: SYNC_REPLICA_GENERATION=initial \
    bash scripts/upgrade-prod.sh --prebuilt --project-name "$SMOKE_PROJECT" --env-file /dev/null \
    "${smoke_overlays[@]}" > "$SMOKE_DIR/upgrade-wrong-recovery-target.log" 2>&1; then
    fail "an upgrade with the previous database selection was accepted"
  fi
  grep -q 'differs from the existing installation' "$SMOKE_DIR/upgrade-wrong-recovery-target.log" ||
    fail "the upgrade refused the previous database selection for the wrong reason"
  for svc in api worker; do
    worker_target=$("${COMPOSE[@]}" exec -T "$svc" bun -e \
      'console.log(new URL(process.env.DATABASE_URL).pathname, process.env.VALKEY_KEY_PREFIX)')
    [ "$worker_target" = "/$recovered_database sob:smoke-recovery:" ] ||
      fail "$svc did not select the recovery database and cache namespace"
  done
  name=$(curl -fsS --max-time 5 "$BASE/api/salon" | json "d['name']")
  [ "$name" = "$restored_name" ] && [ "$name" != "$source_marker" ] ||
    fail "the public API still reads the previous database"
  recovered_jar="$SMOKE_DIR/recovered-owner-cookies"
  curl -fsS --max-time 5 -o /dev/null -c "$recovered_jar" -X POST "$BASE/api/auth/sign-in/email" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" ||
    fail "the restored owner could not sign in"
  step "keep the restored stock history and reject the previous browsing anchor"
  ledger_after=$(curl -fsS --max-time 5 -b "$recovered_jar" "$BASE/api/admin/inventory/movements") ||
    fail "could not read the restored stock ledger"
  [ "$(json "d['anchor']" <<< "$ledger_after")" = "$SYNC_REPLICA_GENERATION~${ledger_anchor#*~}" ] &&
    [ "$(json "d['movements']" <<< "$ledger_after")" = "$(json "d['movements']" <<< "$ledger_before")" ] ||
    fail "restoring changed the ledger position or movement details"
  for endpoint in movements movements/export; do
    stale_ledger_status=$(curl -sS --max-time 5 -b "$recovered_jar" -G \
      --data-urlencode "anchor=$ledger_anchor" "$BASE/api/admin/inventory/$endpoint" \
      -o "$SMOKE_DIR/stale-ledger.json" -w '%{http_code}') ||
      fail "the old stock history request failed in transit"
    [ "$stale_ledger_status" = 409 ] &&
      [ "$(json "d['error']['code']" < "$SMOKE_DIR/stale-ledger.json")" = sync_generation_changed ] ||
      fail "the restored API accepted the old stock history"
  done
  curl -fsS --max-time 5 -b "$recovered_jar" "$BASE/api/sync/pull?since=0&limit=500" \
    > "$SMOKE_DIR/recovered-replica.json" || fail "the restored API did not serve the replica"
  python3 - "$SMOKE_DIR/recovered-replica.json" "$booking_id" "$SYNC_REPLICA_GENERATION" <<'PY' || fail "the restored replica has the wrong generation or lost the booking"
import json, sys
with open(sys.argv[1]) as source:
    page = json.load(source)
    assert page["generation"] == sys.argv[3]
    assert any(row["entity"] == "appointment" and row["id"] == sys.argv[2]
               for row in page["changes"])
PY
  step "block queued changes based on the previous database history"
  stale_mutation=$("${COMPOSE[@]}" exec -T api bun -e 'console.log(Bun.randomUUIDv7())')
  stale_status=$(curl -sS --max-time 5 -b "$recovered_jar" -X POST "$BASE/api/sync/push" \
    -H 'content-type: application/json' -H "origin: $PUBLIC_URL" \
    -d "{\"deviceId\":\"smoke-stale-device\",\"generation\":\"initial\",\"mutations\":[{\"mutationId\":\"$stale_mutation\",\"createdAt\":\"$(date -u +%FT%TZ)\",\"kind\":\"appointment.cancel\",\"payload\":{\"id\":\"$booking_id\",\"version\":1}}]}" \
    -o "$SMOKE_DIR/stale-push.json" -w '%{http_code}') || fail "the stale sync request failed in transit"
  [ "$stale_status" = 409 ] && [ "$(json "d['error']['code']" < "$SMOKE_DIR/stale-push.json")" = sync_generation_changed ] ||
    fail "the restored API did not fence the stale sync request"
  [ "$source_booking" = "$(recovery_booking "$recovered_database")" ] ||
    fail "the stale write modified the restored appointment"
  [ "$source_booking" = "$(recovery_booking sob)" ] ||
    fail "the recovery changed the appointment in the source database"
  [ "$source_marker" = "$("${COMPOSE[@]}" exec -T postgres psql -X -U sob -d sob -qAtc \
    "SELECT name FROM salon_settings")" ] || fail "the previous database was lost or modified"

  step "reverse the synthetic recovery switch"
  "${COMPOSE[@]}" stop caddy web
  "${COMPOSE[@]}" stop api worker
  export SOB_DATABASE_NAME=sob VALKEY_KEY_PREFIX=sob:
  export SYNC_REPLICA_GENERATION=initial
  "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait api worker ||
    fail "the services could not restart on the original database"
  "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait web ||
    fail "the web gateway did not reconnect to the original API"
  verify_recovery_reopening original
  name=$(curl -fsS --max-time 5 "$BASE/api/salon" | json "d['name']")
  [ "$name" = "$source_marker" ] || fail "switching back did not select the original database"
  [ "$source_booking" = "$(recovery_booking "$recovered_database")" ] ||
    fail "switching back modified or lost the restored appointment"
fi

step "containers run as non-root with a read-only root filesystem"
for svc in api web worker; do
  cid="$("${COMPOSE[@]}" ps -q "$svc")"
  user="$(docker inspect -f '{{.Config.User}}' "$cid")"; ro="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")"
  echo "$svc user=${user:-root} readonly=$ro"
  [ -n "$user" ] && [ "$user" != root ] && [ "$user" != 0 ] && [ "${user%%:*}" != 0 ] || fail "$svc runs as root"
  [ "$ro" = true ] || fail "$svc root filesystem is writable"
done

if [ "${SMOKE_EMAIL:-0}" = 1 ]; then
  step "the review invitation remains a single SMTP message after replay"
  # The default worker polling interval is five seconds. Other smoke steps usually cover it.
  remaining=$((review_replayed_at + 6 - SECONDS))
  if [ "$remaining" -gt 0 ]; then sleep "$remaining"; fi
  await_mail smoke-client@example.com 'How was your visit to ' 0 "$review_link" ||
    fail "replaying the review invitation changed the delivered message count"
fi

echo; echo "SMOKE OK"
