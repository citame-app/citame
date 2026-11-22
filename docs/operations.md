# Operations guide

For people who run Sisters of Beauty in production. Everything here matches `compose.prod.yaml`; adapt the commands if you deploy another way. Design background: [ADR 0011](adr/0011-production-hardening.md).

## 1. Deploy

```bash
# 1. Environment (keep this file out of git; it is already ignored)
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export PUBLIC_URL="https://salon.example"          # the public origin, no trailing slash
export SMTP_URL="smtps://user:pass@smtp.example:465"
export NOTIFY_EMAIL_FROM="Sisters of Beauty <no-reply@salon.example>"

# 2. Build and start (migrations run first, in the one-shot `migrate` service)
docker compose -f compose.prod.yaml up -d --build --wait

# 3. First owner (idempotent)
OWNER_EMAIL=you@salon.example OWNER_PASSWORD='a long passphrase' \
  docker compose -f compose.prod.yaml --profile setup run --rm bootstrap-owner

# 4. Automatic HTTPS (optional): point DNS at the host, then
WEB_TRUST_PROXY=true SITE_ADDRESS=salon.example \
  docker compose -f compose.prod.yaml --profile tls up -d
```

The web service trusts no forwarded address by default (`WEB_TRUST_PROXY=false`), because anyone who can reach its port directly could spoof the address the rate limiter uses. Enable it (`WEB_TRUST_PROXY=true`) together with the `tls` profile or your own proxy. Without the `tls` profile the web service listens on `127.0.0.1:4173`; put nginx, Traefik or a cloud load balancer in front, and keep `WEB_TRUST_PROXY=true` only when that proxy appends the visitor's address to `X-Forwarded-For` (Caddy and nginx `$proxy_add_x_forwarded_for` do). `docker/Caddyfile` is a working example; its comments explain each line.

The bundled Caddy proxy probes the web process every two seconds with a one-second timeout. A single web instance can return temporary errors during a restart. The production smoke test verifies that the proxy routes requests within five seconds of the restarted process responding directly, then opens a new staff event stream.

The web proxy returns HTTP 504 after 20 seconds without upload progress or the start of an API response. A slow upload can continue while its data is flowing. The deadline ends when the API responds, so an established sync stream continues with its normal heartbeat. The proxy never retries a write. A write can finish after the gateway times out, so consult its result or recover it using the same request identity before submitting it again.

The PostgreSQL readiness probe uses TCP. On first initialization, the image starts a temporary Unix-socket server for setup and then shuts it down. Migrations wait for the final TCP listener.

`scripts/smoke-prod.sh` builds and migrates a throwaway stack, verifies readiness and owner sign-in, makes a synthetic client booking and confirms a second booking for that slot returns 409. It also checks the public proxy, including OAuth discovery, PKCE registration and consent, a calendar read through MCP, and legacy desktop token rotation. It links three desktop devices and renews their short-lived credentials. A synthetic appointment edit triggers SSE and an incremental pull while keeping the note private. The smoke revokes one device from the web and one from the desktop endpoint, verifies that the web revocation closes the existing stream, and checks that another device keeps access. It also restarts the web gateway with an authenticated sync stream open and checks that it exits cleanly and accepts a new stream through the proxy. The script checks response headers and container permissions and tears down its own stack. Run it before deploying changes to `compose.prod.yaml`.

The smoke also uploads a synthetic product photo and checks the owner's read, private JPEG response, customer and anonymous access restrictions, and invalidation of the old URL after removal. It compares the client report returned to a linked owner device with the web session and checks that the customer and revoked device cannot access that report.

### Environment reference (production)

| Variable                            | Required                       | Meaning                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                 | yes                            | Password of the `sob` database user (also builds `DATABASE_URL` for the services).                                                                                                                                                          |
| `BETTER_AUTH_SECRET`                | yes                            | 32+ characters. Signs sessions and opt-out links and encrypts the OAuth signing keys and queued account emails. **Rotating it logs everybody out and invalidates unsubscribe links in sent emails** (section 6).                            |
| `PUBLIC_URL`                        | yes                            | Public origin; becomes `BETTER_AUTH_URL`, `TRUSTED_ORIGINS` and the base of every emailed link.                                                                                                                                             |
| `SMTP_URL`, `NOTIFY_EMAIL_PROVIDER` | yes unless verification is off | Account and reminder email. The API refuses to start in production with verification required and no provider.                                                                                                                              |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`   | no (true)                      | Clients must confirm their address before signing in.                                                                                                                                                                                       |
| `METRICS_TOKEN`                     | no                             | Bearer token for `/metrics` (16+ chars). Unset: only internal scrapes are answered.                                                                                                                                                         |
| `NOTIFY_*`, `TWILIO_*`              | no                             | See [notifications](notifications.md).                                                                                                                                                                                                      |
| `WEB_TRUST_PROXY`                   | no (false)                     | Trust `X-Forwarded-For` from the proxy in front of `web`. Set `true` with the `tls` profile or your own proxy. The web server refuses to start with it on while `WEB_PUBLISH` is not loopback (override: `WEB_TRUST_PROXY_UNSAFE_OK=true`). |
| `WEB_PUBLISH`                       | no                             | Host binding of the web port (default `127.0.0.1:4173`).                                                                                                                                                                                    |
| `MAINTENANCE_*`, `*_RETENTION_DAYS` | no                             | Housekeeping schedule and windows (section 7).                                                                                                                                                                                              |
| `DB_*`, `HTTP_*`                    | no                             | Pool size, statement/lock/idle-transaction timeouts (10 s / 5 s / 30 s) and HTTP limits; see [env-reference](env-reference.md). Backups use `pg_dump` and are unaffected; in-process maintenance lifts the statement timeout.               |
| `SHUTDOWN_GRACE_MS`                 | no                             | Compose sets 5000.                                                                                                                                                                                                                          |
| `*_FILE`                            | no                             | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SMTP_URL`, `TWILIO_AUTH_TOKEN`, `METRICS_TOKEN` can be read from a file (Docker/Kubernetes secrets), e.g. `BETTER_AUTH_SECRET_FILE=/run/secrets/auth`.                                               |

## 2. Health, logs and metrics

| Endpoint                                  | Use                                           | Answers                                                                                       |
| ----------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health` (API), `GET /healthz` (web) | liveness: restart the container if it fails   | 200 while the process runs                                                                    |
| `GET /ready` (API)                        | readiness: route traffic only while it is 200 | 200 when Postgres and Valkey answer; 503 `unavailable` (with the failing check) or `draining` |
| `GET /metrics` (API, internal)            | Prometheus scrape                             | text exposition format                                                                        |

**Logs** are JSON lines on stdout (`docker compose -f compose.prod.yaml logs -f api`). Follow one request across web and API with its id: `... logs api web | rg '"requestId":"<id>"'`; the id is also the `X-Request-Id` response header users can quote in a support request. Useful fields: `level`, `msg`, `route`, `status`, `durationMs`. Passwords, tokens, cookies, email addresses and query strings are never logged. Docker rotates the files (10 MB x 5).

**Metrics.** Example Prometheus job (the API is reachable only on the compose network, so run Prometheus there or use the token and publish nothing else):

```yaml
scrape_configs:
  - job_name: sob-api
    metrics_path: /metrics
    authorization: { type: Bearer, credentials: "<METRICS_TOKEN>" }
    static_configs: [{ targets: ["api:3000"] }]
```

Suggested alerts: `sob_db_up == 0` or `sob_valkey_up == 0` for 1 minute; 5xx ratio `sum(rate(sob_http_requests_total{status=~"5.."}[5m])) / sum(rate(sob_http_requests_total[5m])) > 0.02`; p95 latency `histogram_quantile(0.95, sum by (le) (rate(sob_http_request_duration_seconds_bucket[5m]))) > 1`; `increase(sob_notifications_dead_lettered_total[1h]) > 0`; a sustained `sob_booking_total{outcome="error"}`. A rising `outcome="slot_taken"` is normal (two people choosing the same time): it is the database constraint working.

## 3. Backup and restore

What holds state:

- **Postgres**: everything that matters (appointments, clients, accounts, settings, the sync log, reminders, OAuth keys). Back this up.
- **Valkey**: sessions, rate-limit counters, SSE fan-out. Losing it signs everybody out and nothing else. `compose.prod.yaml` enables AOF (`appendfsync everysec`) and snapshots on a named volume so a restart keeps sessions; it is **not** part of the backup. If you do want a copy: `docker compose -f compose.prod.yaml exec valkey valkey-cli BGSAVE`, then copy `/data/dump.rdb` out of the volume.

Logical backup (consistent snapshot, custom format, compressed, with a checksum):

```bash
DATABASE_URL=postgres://sob:...@host:5432/sob scripts/backup.sh /backups/sob-$(date -u +%F).dump
# From the host, select the production container with the same Compose project options.
pg_container="$(docker compose -f compose.prod.yaml ps -q postgres)" &&
  test -n "$pg_container" &&
  PG_MODE=docker PG_CONTAINER="$pg_container" \
  DATABASE_URL="postgres://sob@localhost:5432/${SOB_DATABASE_NAME:-sob}" \
  scripts/backup.sh /backups/sob-$(date -u +%F).dump
```

Each run stages the archive and checksum privately on the destination filesystem. The final archive appears after the checksum. Existing names are preserved and a concurrent run using the same output path fails. Use a fresh timestamped name when repeating a backup, and transfer the completed archive and checksum together.

For a remote server, install matching native PostgreSQL client tools and use `PG_MODE=native`. The scripts pass URL connection options such as `sslmode=verify-full` and `sslrootcert` to libpq, including when opening the administrative database during restore. Specify the database in the URL path. Use a libpq service file if the client certificate key needs `sslpassword`.

Docker mode connects to the selected container's local PostgreSQL socket. It accepts only a loopback URL with the default port and no query options. If a native client is missing, a remote or customized URL fails before the script contacts a Docker database.

The standard restore targets an empty database. It requires the matching SHA-256 file and applies the archive in a single transaction. The catalog check detects existing objects even when the restore account cannot read their data. Keep other writers disconnected from the recovery database until validation is complete.

```bash
scripts/restore.sh /backups/sob-2026-11-14.dump postgres://sob:...@host:5432/sob_restored
```

### Switch a Compose deployment to the restored database

Use the same production Compose project options in all commands. Keep the previous database available during validation. Hold public traffic at the load balancer or stop the bundled gateway. Pause any API and worker replicas outside this project. Restore the archive into a new database in the production Postgres container, using a name with letters, digits and underscores. For an archive at migration `0115`, restore in an isolated PostgreSQL instance first, apply `0116` and take a fresh backup there. Use the fresh archive for the Compose recovery.

```bash
compose_options=() # Add the project's --project-name, --env-file and overlay flags here.
compose=(docker compose -f compose.prod.yaml "${compose_options[@]}")
"${compose[@]}" --profile tls stop caddy &&
  "${compose[@]}" stop web api worker &&
  pg_container="$("${compose[@]}" ps -q postgres)" &&
  test -n "$pg_container" &&
  PG_MODE=docker PG_CONTAINER="$pg_container" scripts/restore.sh \
    /backups/sob-2026-11-18.dump postgres://sob@localhost:5432/sob_recovered
```

After verifying the restore, persist the database name, a fresh cache namespace and a fresh sync generation in the deployment environment. The migrator, API, worker and owner setup share the database choice. The previous Valkey keys remain in their original namespace. Before reopening inventory on a restored database, compare the highest order and receipt numbers with documents issued since the backup. If an issued document is missing from the restored history, use **Settings → Document numbering** to advance its series above that number before issuing another document. Generate unique values for each recovery and keep them stable on normal restarts and upgrades.

```dotenv
SOB_DATABASE_NAME=sob_recovered
VALKEY_KEY_PREFIX=sob:recovery-20261118:
SYNC_REPLICA_GENERATION=recovery-20261118-77af035c
```

```bash
"${compose[@]}" run --rm --no-deps --pull never -T migrate
```

Before starting the API on a deployment with separate PostgreSQL roles, reapply the [runtime grants](#4-upgrades-migrations-and-rollback) to the restored database.

```bash
"${compose[@]}" up -d --no-build --no-deps --pull never --wait api
```

Verify the restored appointments and allocations in Postgres while the gateway and worker are stopped. Restore the previous database, cache and generation settings to reverse the validation at this point. Once the recovered database is approved, start the worker and web. Start Caddy only on deployments that use the bundled proxy.

```bash
# Bundled proxy deployments. Pass the same Compose options used above.
"${compose[@]}" up -d --no-build --no-deps --pull never --wait worker web &&
  bun --no-env-file scripts/reopen-recovery-ingress.ts https://citame.example "${compose_options[@]}"
```

The bundled-proxy command requires Python 3 and expects one stopped Caddy container. It compares the database, cache namespace and sync generation of the running API and worker with the selected Compose settings. It checks that the supplied origin matches the web container's `PUBLIC_URL`, that web can reach the API and that the notification worker is ready. It opens that Caddy container, verifies a successful public `/api/ready` request against its access log and checks storage and worker readiness again. A failed check or interruption by SIGINT or SIGTERM after trying to open Caddy triggers a stop of the same container. If Docker cannot confirm the stop, the command reports that ingress needs immediate attention. Run recovery commands from one Docker administration host and coordinate them with any other deployment automation. If a forced termination leaves a lock, confirm the attempt has ended and check whether Caddy is running before removing the reported lock directory. When using an external proxy, hold ingress before stopping writers. Start worker and web, reopen the proxy through its own deployment procedure and check `/api/ready` publicly.

Use `--no-env-file` on the Bun invocation so Compose resolves its own environment files. Exported shell values still take precedence over a Compose `--env-file`. Put the host, database name and any nondefault port in the PostgreSQL URL. The check refuses destination overrides through query parameters or environment settings. The bundled web gateway must route to the Compose `api` service on its configured HTTP port.

Sign in again. The restored API rejects sync pushes from previous generations. Updated desktop clients rebuild their mirrors and retain queued changes in Conflicts for manual review. Review the restored appointment and its payment status before applying an equivalent change. Upgrade older desktop clients before reconnecting them. After reopening, reconcile any new writes before switching again.

`bun run test:scripts` compares row counts and content hashes in every application and migration-journal table after a backup and restore. It verifies that a truncated archive with a matching checksum leaves the target empty and that an occupied target is refused even when the restoring role cannot see the table in `information_schema`. `SMOKE_RESTORE=1 scripts/smoke-prod.sh` rehearses switching the actual production Compose services and reading the recovered appointment through the API.

Schedule it (cron example, daily 03:15, keep 14 days):

```cron
15 3 * * * cd /srv/sob && DATABASE_URL=... scripts/backup.sh /backups/sob-$(date -u +\%F).dump && find /backups -name 'sob-*.dump*' -mtime +14 -delete
```

Copy dumps off the machine and test a restore regularly: an untested backup is a hope, not a backup. For point-in-time recovery use your provider's WAL archiving (managed Postgres) or `pgBackRest`; the logical dump above is the simple baseline.

### Verify Booksy recovery evidence before cutover

Review calendar capture coverage for the agreed local date range and minimum observation time.

```sh
cd apps/api
bun src/scripts/booksy-audit-calendar-window.ts \
  /private/source-snapshot-SHA256.json FIRST_LOCAL_DATE LAST_LOCAL_DATE MIN_CAPTURE_INSTANT
```

Use inclusive ISO dates in the salon's time zone and an ISO timestamp with an offset for the cutoff. The audit verifies the snapshot and original archive bytes. Its private receipt records the timezone and the last full observation for each day within the snapshot, as well as observed dates outside it. Refresh dates that lack an observation covering all snapshot professionals and resources at or after the cutoff. Full coverage requires an archived request for the same dates with unconfirmed bookings included and without additional filters. Queryless or filtered responses can corroborate an individual booking but do not establish completeness. Dates outside the snapshot also need to be added to the projection. Obtain separate source evidence for the last appointment and reconcile all outstanding records. The audit keeps `canCutOver` false.

The locally archived candidate covered 371 dates from 2026-11-18 to 2027-11-23. Every date had a full observation predating the benchmark booking report on 2026-11-18 at 13:13 in Madrid. The latest appointment observed began at 12:10 Madrid time on 2027-04-15. Its position as the last appointment still requires evidence from Booksy.

The offline audit for 2026-11-19 through 2027-11-23 verified all 1,053 archived originals. As of 20:02:25 Madrid time on 2026-11-18, all 370 dates had an archived full observation before the cutoff and zero had a full observation at or after it. The receipt also records `lastAppointmentProven: false` and `canCutOver: false`. The final coverage check needs a fresh source capture when the centre resumes the migration.

Rehearse recovery from the externally held copy of the final Booksy candidate. Save the output of `booksy-portable-backup.ts rehearse-schedule` as a private file with mode 0600. Use the [Booksy import protocol](booksy-import-protocol.md#reservas-de-prueba-en-la-agenda-recuperada) to select the rehearsal date and recover the candidate.

From the source checkout for the intended release, compare the receipt with the final snapshot SHA-256, the independently recorded encrypted archive SHA-256 and the agreed rehearsal date.

```sh
cd apps/api
bun src/scripts/booksy-portable-backup.ts verify-rehearsal \
  /private/rehearsal.json FINAL_SNAPSHOT_SHA256 RECORDED_CIPHER_SHA256 YYYY-MM-DD
```

The command checks the receipt for the capacity, booking, rescheduling, checkout, inventory, waitlist, replica and rollback results. For each archived waitlist request it requires evidence that the active policy refused a new import, an omitted staff preference was refused, an explicit preference for any qualified professional was accepted and an identical replay returned the same entry after offers were enabled. The paused engine must record zero scans, offers and reminders. Rerun older receipts that lack this evidence. The verifier checks the migration count and the hash of the entire ordered ledger against the checkout. A successful result confirms that this trusted receipt matches the selected inputs. Verify the application build and external custody separately and obtain the centre operator's approval for the cutover.

Use [the operational-copy rehearsal](booksy-import-protocol.md#ensayar-la-separación-de-la-base-operativa) to verify a separate native database from the same archive. It checks the copied tables and migration ledger, excludes the private source schema, verifies that no accounts or delivery configuration are carried and pauses public booking. The pinned Valkey image must be present locally. The rehearsal uses disposable PostgreSQL and Valkey instances to exercise the normal signed-in calendar and verify that customer booking is blocked.

Verify the trusted receipt for the selected operational rehearsal using the same references. Append `operational-copy` for the sign-in, permissions and restored replica proof. Append `operational-write` for a receipt that also demonstrates both sync directions, confirmed live changes, an idempotent replay, stale-version rejection and device revocation.

```sh
cd apps/api
bun src/scripts/booksy-portable-backup.ts verify-rehearsal \
  /private/operational-write.json FINAL_SNAPSHOT_SHA256 RECORDED_CIPHER_SHA256 YYYY-MM-DD \
  operational-write
```

Keep the receipt private and obtain the reference hashes independently. The verifier checks internal consistency and the exact release ledger. Each scope requires its own evidence and preserves `canCutOver: false`.

The local 2026-11-21 rehearsal verified all three receipts for the archived agenda on 2026-11-26 against the same 101-migration ledger. The operational receipts covered 787 imported lines and 26 lines that day. The verifier rejected the write receipt when checked against a different day.

The local rehearsal `release-evidence-recovery.*` verified the 69 migrations up to `0068`. The command accepted that receipt for 2026-11-18 and rejected it for 2026-11-19. It also rejected a previous receipt that lacked the full ledger hash.

The local rehearsals `review-email-ledger-recovery.*` and `next-day-0070-recovery.*` verified all 71 migrations through `0070` against the encrypted candidate backup for 2026-11-18 and 2026-11-19. The disposable databases restored the 94 original tables and verified the 1,053 archived source files. Rollback preserved the contents of all 98 migrated tables after the scheduling rehearsals. Each receipt covers its archived snapshot and date.

## 4. Upgrades, migrations and rollback

The upgrade command requires Python 3 on the deployment host. It compares the rendered Compose database and cache settings with the existing API and worker containers before building or migrating. Use the environment of the current installation, including its cache namespace and sync generation. To change databases, use the recovery procedure.

1. Back up using section 3 and record the running image tag.
2. Check out the release and run `scripts/upgrade-prod.sh` with the deployment's Compose project options. When building on the host, set `SOB_TAG` to a distinct version. For published images, set `SOB_API_IMAGE` and `SOB_WEB_IMAGE` to the release digests, pull them, and pass `--prebuilt` before the Compose options.
3. Check `/api/ready` through the public origin, inspect the logs and sign in.

The upgrade builds or verifies the requested images and runs the migration against the existing database. It validates the candidate Caddy configuration when the project has a running Caddy service. After migration it recreates that proxy from the current checkout before replacing API, worker and web. The brief reconnection applies to the bundled proxy and includes open SSE streams. Manage equivalent changes on an external proxy through its deployment procedure. A failed online migration preserves the existing containers. The script is for an existing installation with healthy Postgres and Valkey. Use the installation procedure for a new stack.

Migrators targeting the same database wait for a PostgreSQL advisory lock before reading the migration journal. They validate the applied entries before running any pending SQL and check the resulting journal before reporting success. They hold the lock on the migration connection until it closes. Coordinate release activation separately when more than one deployment can target the same installation.

The production API and worker verify the release's ordered migration timestamps and SQL hashes before opening the listener or starting background jobs. If the database is behind, apply the release migrations before restarting the services. A forward-compatible code rollback can use a strictly newer ledger suffix when all entries required by the older release still match. The recovery rehearsal continues to require an exact match.

If the API and worker use separate PostgreSQL roles from the migrator, grant both runtime roles `USAGE` on schema `drizzle` and `SELECT` on `drizzle.__drizzle_migrations` after the initial migration and before starting the services.

With separate database roles, grant the API role `EXECUTE` on `public.inventory_numbering_status(text)` and `public.inventory_numbering_advance(text, integer, integer)` after applying the numbering migrations. Reapply those grants after restoring into an installation with separate roles. Migration `0116_private_inventory_numbering` keeps existing grants during an upgrade and rejects the default `PUBLIC` grant at runtime after a restore that omits ACLs. A backup captured at migration `0115` contains the earlier routines. Restore that intermediate backup in a network-isolated PostgreSQL instance and apply `0116` before moving or reopening the database.

The deployment migrator and sample seed reject reserved Booksy review database names and any database with the `booksy_rehearsal` schema. The check uses the connected database name as well as the URL, so an environment override such as `PGDATABASE` cannot direct these commands to a review database. Renaming or restoring a full candidate dump under an ordinary name leaves the schema guard in place. The portable recovery command can still migrate its disposable PostgreSQL copy for the rehearsal.

On a normal worker stop, each notification queue finishes its current delivery and releases reserved jobs it has not started. Released appointment and account emails keep their original delivery-attempt counts. A campaign cancellation still withdraws its reserved deliveries. The standalone worker has a 75-second Compose stop grace period to allow for the SMTP exchange and the final database update.

Compose waits for worker readiness during startup and upgrades. The worker checks PostgreSQL and its read and update grants on notification queue tables through a private loopback listener after starting its queues. It closes the listener when shutdown begins. Monitor delivery failures through the notification logs and queue metrics.

Migrations are forward-only SQL files in `packages/db/drizzle`. The migrator uses Drizzle transactions for the normal journal and controls the transaction boundary for the legacy and enum upgrades below. Applied files are never edited. **Rolling back code is safe when the new release added no migration** (`SOB_TAG=<old> ... up -d`). If it did, the older code usually still works with the newer schema because releases only add columns/tables; when a release says otherwise (a destructive migration), restore the pre-upgrade backup into a new database and point the old tag at it. Plan destructive changes as expand, deploy, contract over two releases.

Migration `0061_live_view_changes` appends online-view notifications to the sync log. The default upgrade refuses a database that has yet to apply it. Drain any API and worker replicas outside the Compose project first, then run `scripts/upgrade-prod.sh --maintenance` with the deployment’s Compose options. The API is unavailable while its writers are stopped. If migration fails, the script starts the same API and worker containers. It checks that the running web gateway reaches the previous API and keeps that gateway running when the check passes. If it fails, the script restarts the gateway and checks it again. After the migration succeeds, only deploy API versions that understand live-view notifications. To return to an older API, restore the pre-upgrade backup first.

Migration `0076_sync_calendar_annotation_badges` also requires `scripts/upgrade-prod.sh --maintenance`. Stop every old API replica before applying it. An old API could otherwise serve the backfill and advance a desktop cursor without returning the new indicators. The migration appends sync events for imported Booksy appointments and appointments with scheduling indicators. On the next sync, restricted staff receive preference and note-presence indicators for their own appointments. Full annotation text still goes through the authorized appointment endpoint. For a rollback to an API release predating `0076`, follow the restore procedure with the pre-upgrade backup and reconcile writes made since the backup before reopening.

Migration `0099_inventory_classification` links existing product category and brand labels by ID. Use `scripts/upgrade-prod.sh --maintenance` and drain inventory writers outside the Compose project before migrating. Existing labels, stock and product versions are preserved. Older API versions write label columns without updating the new IDs, so restore and reconcile a pre-upgrade backup before reverting to one after the migration.

Migration `0101_booksy_payment_review` also requires `scripts/upgrade-prod.sh --maintenance`. Drain every old API replica before applying it. Older code can advance a desktop cursor without reporting the payment hold and can still accept a collection based on incomplete source evidence. To revert to an API predating this migration, keep traffic closed and restore and reconcile the pre-upgrade backup before reopening.

Migration `0106_sync_client_email_editability` requires `scripts/upgrade-prod.sh --maintenance`. Drain old API readers so their responses cannot advance a desktop cursor past the new contact projection. The migration appends sync events for existing standalone contacts and preserves their stored details. Keep API readers that support this projection after the upgrade. To revert to an older API, close traffic, preserve pending desktop changes, and restore and reconcile the pre-upgrade backup before reopening. If an older reader already advanced a desktop cursor, flush pending desktop changes after returning to the current release and rebuild the affected desktop replica from a full sync. Rerunning the migrator alone will not replay the events.

Migration `0107_sync_visit_itineraries` requires `scripts/upgrade-prod.sh --maintenance`. Drain old API readers before applying it. The migration appends sync events for existing native visit parts and preserves the stored appointments and imported group IDs. To return to an older API, close traffic and reconcile a pre-upgrade backup. If an older reader already advanced a desktop cursor, preserve pending edits and rebuild the affected replica from a full sync after returning to this release.

Upgrades that add the WhatsApp notification channel to an existing database commit through `0047` before later triggers use the enum value. For the upstream catalogue history, this first step adds just the enum value under the migration lock and leaves the upstream journal in place until the full schema merge commits. A failed upgrade can be retried. Existing migration files and checksums are preserved.

Use a maintenance upgrade when moving from either pre-merge migration history to migration `0080`. The merged journal retains the local history through `0076` and adds catalog presentation, grouped visits, pricing and booking intervals in `0077`–`0080`. If the database applied the earlier upstream migrations `0041`–`0044`, the migrator recognizes their exact hashes and applies the missing changes in one transaction. Take a backup before upgrading and verify the journal and calendar on a restored copy. The catalogue migration trims surrounding spaces in live service categories. The Booksy source archive retains the original category text.

Migration `0071_review_request_live_view` adds review invitation notices to the same log. When rolling out across several hosts, replace all API readers before relying on the new topic and reconnect open clients after the rollout. Older readers that already support live-view notifications skip the topic and advance the cursor. Reconnecting reloads any open review list.

A failed migration still exits with a failure status after recovery. If recovery restarts the gateway, verify readiness at the public origin as well. The bundled Caddy proxy checks its upstream every two seconds and can still be waiting for its next check when the gateway's local probe passes. The disposable smoke requires the original API, worker, gateway and Caddy containers to remain in place and checks the preserved booking. It requires immediate public readiness when the gateway reconnects on its own and allows up to six seconds after a reported gateway restart.

With `SMOKE_UPGRADE=1`, the smoke also builds distinct local prebuilt images for a successful maintenance upgrade. The API image embeds a synthetic migration that checks for database connections from other containers before applying its schema change. The smoke then checks the image ID of each replacement service, preserved booking data and public readiness. The release workflow separately verifies published image digests and provenance.

Migration `0062_damp_wiccan` adds the desktop device registry. Apply it before publishing the new API. Update the web and API before distributing the desktop client so it can register its key on first sign-in. Keep the same authorization origin and secret on every API replica.

Migration `0063_sync_service_colors` re-announces catalog rows through desktop sync. Upgraded desktop clients also fetch configured colors once, including when an older release already advanced past those log entries.

Migration `0102_email_delivery_live_view` adds an owner-only email settings invalidation. Upgrade every API replica before rolling out the matching Web and Desktop clients. Older APIs can advance past the new topic without delivering it. Reload Web and reconnect Desktop to refresh the current settings after a mixed-version rollout or rollback. The legacy email test remains available to existing clients. Updated clients use the reviewed test route, which requires the revision shown on screen.

Migration `0103_whatsapp_desk_live_view` adds owner-only invalidation for connected sender and delivery status. Roll out all API replicas before relying on the new topic. Reconnect open clients after a mixed-version rollout or rollback because old readers skip unknown topics. The marker contains no sender or delivery data.

Migration `0104_whatsapp_settings_live_view` adds a separately negotiated connection invalidation so open web forms refresh saved settings while preserving their reviewed drafts. The earlier marker remains available for Desktop monitoring. Update all API replicas before deploying the new Web and Desktop clients. Reload open web tabs after an upgrade or rollback. Updated clients submit the opaque sender revision to the reviewed rules endpoint. The service checks it before contacting Meta and again after locking the current connection. Reviewed disconnection from Web or Desktop checks the revision of the number shown in the confirmation. It cancels pending and undispatched jobs while keeping delivery history. Reviewed Embedded Signup rejects a stale connect or renewal before exchanging the Meta code. Separate disconnected periods have distinct signup revisions so an earlier popup cannot reconnect a number after another session has disconnected it.

Migration `0064_whatsapp_dispatch_sender` adds nullable sender identifiers to existing reminders. Deploy the API and worker after migrating. Unattributed historical sends retain their delivery state and can receive updates when the existing provider message ID matches the connected sender.

On a single-replica installation, the gateway can return a brief error while Compose replaces a service. An API replica reports itself unready during `SHUTDOWN_GRACE_MS`. For rolling upgrades, an external load balancer or orchestrator must honor readiness and keep a healthy replica available.

## 5. Scaling notes

- The API and web are stateless: run several replicas behind the proxy. Sessions, rate limits and SSE fan-out go through Valkey, so replicas share them. Each replica needs `TRUST_PROXY=true` only behind the web service.
- The booking path is protected by the database (`appointment` exclusion constraint), not by locks in the process, so replicas do not coordinate. Measured numbers are in [performance.md](performance.md).
- Connection budget: each API/worker process opens up to 10 Postgres connections (`sob_db_pool_max_connections`); default Postgres allows 100.
- Run any number of workers: reminders are claimed with `SKIP LOCKED`, housekeeping with an advisory lock.
- Watch Postgres first: disk (the sync log and reminders grow until housekeeping trims them), connections, and slow queries (`pg_stat_statements` if enabled).

## 6. Secrets rotation

| Secret                           | How                                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`              | `ALTER USER sob PASSWORD '...'` in Postgres, set the new value, `up -d` | brief reconnect                                                                                                                                                                                                                                                                                                                                                           |
| `SMTP_URL` / `TWILIO_AUTH_TOKEN` | set the new value, `up -d api worker`                                   | none; queued messages retry                                                                                                                                                                                                                                                                                                                                               |
| `METRICS_TOKEN`                  | change it and the Prometheus job                                        | scrape gap until both match                                                                                                                                                                                                                                                                                                                                               |
| `BETTER_AUTH_SECRET`             | set the new value, `up -d`                                              | **everyone is signed out**, the OAuth signing keys (encrypted with it) can no longer be read so MCP/desktop clients must reconnect, unsubscribe links in already-sent emails stop working, and queued account emails become unreadable. Drain account mail first where possible; request fresh links after rotation. Rotate only after a suspected leak, at a quiet hour. |
| A person's password              | they use "Forgot your password?"; the reset ends their other sessions   |                                                                                                                                                                                                                                                                                                                                                                           |

## 7. Housekeeping (scheduled compaction)

The worker runs `runMaintenance` 60 s after start and then every `MAINTENANCE_INTERVAL_HOURS` (24). Multiple workers are safe (advisory lock). One-shot from cron: `bun run maintenance` (prints a JSON report). It removes only what nothing reads or what is past its window:

| What                                  | Window (env)                                   | Notes                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Superseded `sync_change` rows         | 30 days (`SYNC_LOG_RETENTION_DAYS`)            | The newest entry of every row stays, so cursors stay valid. **Tombstones are never purged**: a desktop offline longer than any window would resurrect a deleted row (ADR 0007). A device offline longer than the window still converges, because pull returns current row state. |
| Sent / skipped / cancelled reminders  | 90 days (`REMINDER_RETENTION_DAYS`)            | Pending and in-flight rows are never touched.                                                                                                                                                                                                                                    |
| Account emails                        | Same terminal windows as reminders             | Expired queued links are skipped and scrubbed even with no provider; active leases are preserved. Terminal payloads are erased immediately.                                                                                                                                      |
| Dead-lettered reminders               | 180 days (`DEAD_LETTER_RETENTION_DAYS`)        | Kept longer so operators can investigate.                                                                                                                                                                                                                                        |
| Expired OAuth access/refresh tokens   | 7 days after expiry (`OAUTH_TOKEN_GRACE_DAYS`) |                                                                                                                                                                                                                                                                                  |
| Idle OAuth clients                    | 30 days (`OAUTH_IDLE_CLIENT_DAYS`)             | Dynamically registered clients with no token and no consent; the desktop client is exempt.                                                                                                                                                                                       |
| Expired verification values, sessions | 1 day after expiry                             |                                                                                                                                                                                                                                                                                  |

`audit_log` is intentionally kept forever (it is small and is the record of who changed what); archive it yourself if policy requires.

## 8. Troubleshooting

- **Nobody can sign up / "check your inbox" never arrives**: check `accountEmails` in `/admin/notifications/stats` or `sob_account_email_queue` and the safe `last_error` codes in `account_email_outbox`; then check `SMTP_URL` and your provider's logs. Try Mailpit locally (`docker compose --profile mail up -d mailpit`, inbox on http://localhost:8025).
- **`/ready` is 503**: the response names `database` or `valkey`; check that service's health and `docker compose logs`.
- **Everybody gets 429**: the client address is wrong behind your proxy (all visitors share one). Check `WEB_TRUST_PROXY` and that the proxy appends to `X-Forwarded-For`. A rendered page that hits the limit answers `429` with `Retry-After` (never a `500`); one server-rendered page costs a few API calls (3 on `/book`, more when signed in), so size `RATE_LIMIT_GLOBAL_MAX` per visitor accordingly.
- **Cookie not kept on http**: production sets `Secure` cookies; use https (or `localhost`).

## Appointment email

The owner can choose the sender under **Settings → Email delivery**. The initial
mode inherits `NOTIFY_EMAIL_PROVIDER`, `SMTP_URL` and `NOTIFY_EMAIL_FROM`.
The selected override applies to new deliveries from the appointment queue
without a worker restart. The reminder schedule and customer preferences still
apply. Sign-in, recovery and marketing email use the server configuration.

- **SMTP** accepts a public SMTP hostname, a port, a username and password, and
  either STARTTLS (typically port 587) or implicit TLS (typically port 465).
  Configure private or IPv6-only relays through the deployment environment.
- **Gmail / Google Workspace** uses the sender mailbox and its Google app
  password over TLS. The Google account must support app passwords. The Gmail
  preset does not start a Google account authorization flow.
- **Resend** uses a sending API key and an address on a verified domain. Citame
  passes the reminder ID as the provider's idempotency key on retries.

After saving, use **Send test email** to check provider acceptance using the
current owner's address. Saving alone does not send a test. Returning to server
settings or disabling appointment email removes the saved provider credential.

Run `SMOKE_EMAIL=1 bash scripts/smoke-prod.sh` to verify the test message, booking
confirmation, reminders and review invitation through the production API and
worker with a private Mailpit sink. The suite checks that pausing and restoring
appointment email takes effect without a worker restart. It also replays a
review invitation request and verifies the link to the visit, the opt-out link
and the delivery status through the proxy. At the end of the run it checks that
the private sink still contains a single invitation.

Credentials are encrypted using the deployment's `BETTER_AUTH_SECRET`. After
rotating that secret, re-enter the override credential before restarting
appointment deliveries. SMTP delivery is at least once if a worker loses its
connection after the provider accepts a message.
