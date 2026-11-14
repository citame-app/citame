# Operations guide

For people who run Sisters of Beauty in production. Everything here matches `compose.prod.yaml`; adapt the commands if you deploy another way. Design background: [ADR 0011](adr/0011-production-hardening.md).

## 1. Deploy

```bash
# 1. Environment (keep this file out of git; it is already ignored)
export POSTGRES_PASSWORD="$(openssl rand -base64 24)"
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
SITE_ADDRESS=salon.example ACME_EMAIL=you@salon.example \
  docker compose -f compose.prod.yaml --profile tls up -d
```

Without the `tls` profile the web service listens on `127.0.0.1:4173`; put nginx, Traefik or a cloud load balancer in front, and keep `WEB_TRUST_PROXY=true` only when that proxy appends the visitor's address to `X-Forwarded-For` (Caddy and nginx `$proxy_add_x_forwarded_for` do). `docker/Caddyfile` is a working example; its comments explain each line.

`scripts/smoke-prod.sh` runs this whole procedure against a throwaway stack (build, migrate, owner, readiness, sign-in, public availability, a client booking and a 409 on the same slot, headers, non-root/read-only checks) and tears it down; run it before trusting a change to `compose.prod.yaml`.

### Environment reference (production)

| Variable                            | Required                       | Meaning                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                 | yes                            | Password of the `sob` database user (also builds `DATABASE_URL` for the services).                                                                                                            |
| `BETTER_AUTH_SECRET`                | yes                            | 32+ characters. Signs sessions and opt-out links and encrypts the OAuth signing keys. **Rotating it logs everybody out and invalidates unsubscribe links in sent emails** (section 6).        |
| `PUBLIC_URL`                        | yes                            | Public origin; becomes `BETTER_AUTH_URL`, `TRUSTED_ORIGINS` and the base of every emailed link.                                                                                               |
| `SMTP_URL`, `NOTIFY_EMAIL_PROVIDER` | yes unless verification is off | Account and reminder email. The API refuses to start in production with verification required and no provider.                                                                                |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`   | no (true)                      | Clients must confirm their address before signing in.                                                                                                                                         |
| `METRICS_TOKEN`                     | no                             | Bearer token for `/metrics` (16+ chars). Unset: only internal scrapes are answered.                                                                                                           |
| `NOTIFY_*`, `TWILIO_*`              | no                             | See [notifications](notifications.md).                                                                                                                                                        |
| `WEB_TRUST_PROXY`                   | no (true)                      | Trust `X-Forwarded-For` from the proxy in front of `web`.                                                                                                                                     |
| `WEB_PUBLISH`                       | no                             | Host binding of the web port (default `127.0.0.1:4173`).                                                                                                                                      |
| `MAINTENANCE_*`, `*_RETENTION_DAYS` | no                             | Housekeeping schedule and windows (section 7).                                                                                                                                                |
| `SHUTDOWN_GRACE_MS`                 | no                             | Compose sets 5000.                                                                                                                                                                            |
| `*_FILE`                            | no                             | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SMTP_URL`, `TWILIO_AUTH_TOKEN`, `METRICS_TOKEN` can be read from a file (Docker/Kubernetes secrets), e.g. `BETTER_AUTH_SECRET_FILE=/run/secrets/auth`. |

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
# inside the compose stack, from the host:  PG_MODE=docker scripts/backup.sh   (runs pg_dump in the postgres container)
```

Restore always goes into an **empty** database; the script refuses a non-empty target and a checksum mismatch:

```bash
scripts/restore.sh /backups/sob-2026-11-14.dump postgres://sob:...@host:5432/sob_restored
```

To recover production: stop `api` and `worker`, restore into a new database, check it (`psql` row counts, sign in), point `DATABASE_URL` at it (or rename databases), start the services. The procedure is exercised by `bun run test:scripts`, which backs up a seeded database, restores it into a fresh one and compares the row count of every table.

Schedule it (cron example, daily 03:15, keep 14 days):

```cron
15 3 * * * cd /srv/sob && DATABASE_URL=... scripts/backup.sh /backups/sob-$(date -u +\%F).dump && find /backups -name 'sob-*.dump*' -mtime +14 -delete
```

Copy dumps off the machine and test a restore regularly: an untested backup is a hope, not a backup. For point-in-time recovery use your provider's WAL archiving (managed Postgres) or `pgBackRest`; the logical dump above is the simple baseline.

## 4. Upgrades, migrations and rollback

1. Back up (section 3). Note the current image tag.
2. `git pull` (or fetch the new release), then `SOB_TAG=<new> docker compose -f compose.prod.yaml up -d --build --wait`. Compose runs `migrate` first; the API and worker only start after it succeeds, and a failed migration leaves the old containers running.
3. Check `/ready`, the logs for `level":"error"`, and sign in.

Migrations are forward-only SQL files in `packages/db/drizzle`, applied inside a transaction by Drizzle; applied files are never edited. **Rolling back code is safe when the new release added no migration** (`SOB_TAG=<old> ... up -d`). If it did, the older code usually still works with the newer schema because releases only add columns/tables; when a release says otherwise (a destructive migration), restore the pre-upgrade backup into a new database and point the old tag at it. Plan destructive changes as expand, deploy, contract over two releases.

The web and API containers are stateless, so a rolling restart is: scale `api` to two replicas, `up -d --no-deps api`, and let `/ready` take the old one out (the grace period is `SHUTDOWN_GRACE_MS`, stop timeout 20 s).

## 5. Scaling notes

- The API and web are stateless: run several replicas behind the proxy. Sessions, rate limits and SSE fan-out go through Valkey, so replicas share them. Each replica needs `TRUST_PROXY=true` only behind the web service.
- The booking path is protected by the database (`appointment` exclusion constraint), not by locks in the process, so replicas do not coordinate. Measured numbers are in [performance.md](performance.md).
- Connection budget: each API/worker process opens up to 10 Postgres connections (`sob_db_pool_max_connections`); default Postgres allows 100.
- Run any number of workers: reminders are claimed with `SKIP LOCKED`, housekeeping with an advisory lock.
- Watch Postgres first: disk (the sync log and reminders grow until housekeeping trims them), connections, and slow queries (`pg_stat_statements` if enabled).

## 6. Secrets rotation

| Secret                           | How                                                                     | Effect                                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`              | `ALTER USER sob PASSWORD '...'` in Postgres, set the new value, `up -d` | brief reconnect                                                                                                                                                                                                                                     |
| `SMTP_URL` / `TWILIO_AUTH_TOKEN` | set the new value, `up -d api worker`                                   | none; queued messages retry                                                                                                                                                                                                                         |
| `METRICS_TOKEN`                  | change it and the Prometheus job                                        | scrape gap until both match                                                                                                                                                                                                                         |
| `BETTER_AUTH_SECRET`             | set the new value, `up -d`                                              | **everyone is signed out**, the OAuth signing keys (encrypted with it) can no longer be read so MCP/desktop clients must reconnect, and unsubscribe links in already-sent emails stop working. Rotate only after a suspected leak, at a quiet hour. |
| A person's password              | they use "Forgot your password?"; the reset ends their other sessions   |                                                                                                                                                                                                                                                     |

## 7. Housekeeping (scheduled compaction)

The worker runs `runMaintenance` 60 s after start and then every `MAINTENANCE_INTERVAL_HOURS` (24). Multiple workers are safe (advisory lock). One-shot from cron: `bun run maintenance` (prints a JSON report). It removes only what nothing reads or what is past its window:

| What                                  | Window (env)                                   | Notes                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Superseded `sync_change` rows         | 30 days (`SYNC_LOG_RETENTION_DAYS`)            | The newest entry of every row stays, so cursors stay valid. **Tombstones are never purged**: a desktop offline longer than any window would resurrect a deleted row (ADR 0007). A device offline longer than the window still converges, because pull returns current row state. |
| Sent / skipped / cancelled reminders  | 90 days (`REMINDER_RETENTION_DAYS`)            | Pending and in-flight rows are never touched.                                                                                                                                                                                                                                    |
| Dead-lettered reminders               | 180 days (`DEAD_LETTER_RETENTION_DAYS`)        | Kept longer so operators can investigate.                                                                                                                                                                                                                                        |
| Expired OAuth access/refresh tokens   | 7 days after expiry (`OAUTH_TOKEN_GRACE_DAYS`) |                                                                                                                                                                                                                                                                                  |
| Idle OAuth clients                    | 30 days (`OAUTH_IDLE_CLIENT_DAYS`)             | Dynamically registered clients with no token and no consent; the desktop client is exempt.                                                                                                                                                                                       |
| Expired verification values, sessions | 1 day after expiry                             |                                                                                                                                                                                                                                                                                  |

`audit_log` is intentionally kept forever (it is small and is the record of who changed what); archive it yourself if policy requires.

## 8. Troubleshooting

- **Nobody can sign up / "check your inbox" never arrives**: the API logs `account email failed` (no addresses) when SMTP rejects; check `SMTP_URL` and your provider's logs. Try Mailpit locally (`docker compose --profile mail up -d mailpit`, inbox on http://localhost:8025).
- **`/ready` is 503**: the response names `database` or `valkey`; check that service's health and `docker compose logs`.
- **Everybody gets 429**: the client address is wrong behind your proxy (all visitors share one). Check `WEB_TRUST_PROXY` and that the proxy appends to `X-Forwarded-For`.
- **Cookie not kept on http**: production sets `Secure` cookies; use https (or `localhost`).
