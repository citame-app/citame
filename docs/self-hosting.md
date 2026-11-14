# Self-hosting guide

From an empty server to a salon taking bookings, with HTTPS, email, backups and upgrades. Written for one salon on one machine. The day-two details (metrics, housekeeping, secrets rotation) are in [operations.md](operations.md); every variable is in [env-reference.md](env-reference.md).

What the production stack is (`compose.prod.yaml`): Postgres 18, Valkey 9, the API, a worker (reminders and housekeeping), the web server, and an optional Caddy for HTTPS. Only the web service listens on a host port (loopback by default); the databases are never exposed.

## 1. Requirements

| Item     | Minimum                                                     | Notes                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | 1 vCPU, 2 GB RAM, 10 GB disk, Linux x86_64 or arm64         | Container limits in the compose file add up to about 3.5 GB at their ceiling; real use is far below it. The load figures in [performance.md](performance.md) were measured on a laptop. |
| Software | Docker Engine 26+ with the Compose plugin, `git`, `openssl` | Nothing else is installed on the host; images build from source (a few minutes the first time).                                                                                         |
| Network  | A public IPv4 (or IPv6) address, ports 80 and 443 open      | Port 80 is needed by Let's Encrypt validation.                                                                                                                                          |
| Domain   | A host name you control, e.g. `salon.example`               | Cookies are `Secure`, so the public site must be https.                                                                                                                                 |
| Email    | An SMTP account (provider, or your own server)              | Required: clients must confirm their address, and reminders go out by email. See section 4.                                                                                             |

## 2. DNS and TLS

1. Create an `A` (and `AAAA` if you have IPv6) record for `salon.example` pointing at the server.
2. Make sure nothing else listens on 80 and 443, and that the firewall allows both (and 443/udp for HTTP/3).
3. TLS is automatic: with the `tls` profile, Caddy obtains and renews a Let's Encrypt certificate for `SITE_ADDRESS`. Set `SITE_ADDRESS` to the bare host name (`salon.example`, no scheme). For the expiry-notice contact, uncomment the `email` block at the top of `docker/Caddyfile`.
4. Already have a load balancer or nginx? Skip the profile, keep `WEB_PUBLISH=127.0.0.1:4173`, and proxy to it. Keep `WEB_TRUST_PROXY=true` only if your proxy appends the visitor's address to `X-Forwarded-For`; stream `/api/sync/stream` unbuffered (Server-Sent Events).

## 3. Get the code and configure it

```bash
git clone <your fork or this repository> /srv/sob && cd /srv/sob
git checkout v0.1.0                      # deploy a tag, not a moving branch
```

Create `/srv/sob/.env` (it is git-ignored; `chmod 600`). Generate the secrets once and **keep them stable**: changing `BETTER_AUTH_SECRET` signs everyone out and breaks old unsubscribe links.

```bash
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
PUBLIC_URL=https://salon.example
SMTP_URL=smtps://user:password@smtp.example:465
NOTIFY_EMAIL_FROM=Sisters of Beauty <no-reply@salon.example>
SITE_ADDRESS=salon.example
SOB_TAG=0.1.0
EOF
```

`PUBLIC_URL` has no trailing slash. URL-encode special characters in the SMTP user and password (`@` becomes `%40`). The full table, including SMS, metrics and retention settings, is in [env-reference.md](env-reference.md). Prefer Docker secrets? Use the `*_FILE` variants.

## 4. SMTP setup

Any SMTP provider works (Postmark, SES, Mailgun, Brevo, your hosting provider, a self-run server). You need three things:

- the SMTP URL: `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587` (STARTTLS),
- a sender address on a domain you control (`NOTIFY_EMAIL_FROM`),
- SPF, DKIM and DMARC records for that domain as your provider describes them; without them, confirmation emails land in spam and clients cannot sign up.

Test before opening the doors: after the stack is up, sign up with a personal address on the site and check that the confirmation arrives. If it does not, `docker compose -f compose.prod.yaml logs api | rg "account email failed"` (addresses are never logged) and your provider's logs tell you why. To run without email on a private network, set `AUTH_REQUIRE_EMAIL_VERIFICATION=false` and `NOTIFY_EMAIL_PROVIDER=none` explicitly: the API refuses to start in production with verification required and no provider, on purpose.

Reminders run only when the worker is running (it is its own service here) and a provider is set. SMS is optional and has regulatory implications: read [notifications.md](notifications.md) first.

## 5. First start and the owner account

```bash
docker compose -f compose.prod.yaml up -d --build --wait    # postgres, valkey, one-shot migrate, api, worker, web
docker compose -f compose.prod.yaml --profile tls up -d      # Caddy: HTTPS on 80/443
```

The `migrate` service creates the schema and the double-booking constraint; the API and worker start only after it succeeds.

Create the **owner** (the only account that can administer the salon; sign-up always creates clients). Idempotent: running it again changes nothing.

```bash
OWNER_EMAIL=you@salon.example OWNER_PASSWORD='a long passphrase of your own' OWNER_NAME='Your Name' \
  docker compose -f compose.prod.yaml --profile setup run --rm bootstrap-owner
```

Then open `https://salon.example/sign-in`, sign in, and go to **Admin**:

1. **Settings**: salon name, timezone (this is where the timezone lives; the `SALON_TIMEZONE` environment variable is not read), slot interval, minimum notice, booking window, reminder lead times.
2. **Services**: the catalogue. A fresh database is empty. To start from generic placeholder data instead of typing everything, run once: `docker compose -f compose.prod.yaml run --rm --no-deps migrate bun packages/db/src/scripts/seed.ts` and then edit or deactivate the sample services and stylists (the seed is idempotent and is meant for trying the product).
3. **Team**: add staff (they get an invitation email and choose their own password), their weekly hours and time off.

Check the lights: `curl -s https://salon.example/healthz`, `docker compose -f compose.prod.yaml ps` (everything `healthy`, `migrate` exited 0), and make a test booking as a client. `scripts/smoke-prod.sh` does all of this automatically against a throwaway stack.

## 6. Backups

State is in Postgres. Schedule the logical dump from [operations.md](operations.md#3-backup-and-restore), copy it off the machine, and rehearse a restore before you need it:

```bash
cd /srv/sob
PG_MODE=docker PG_CONTAINER="$(docker compose -f compose.prod.yaml ps -q postgres)" \
  scripts/backup.sh /srv/backups/sob-$(date -u +%F).dump
```

Valkey only holds sessions and counters; losing it signs people out and nothing more.

## 7. Upgrades

```bash
cd /srv/sob
scripts/backup.sh ...                      # always first
git fetch --tags && git checkout v0.1.1    # read the CHANGELOG entry
sed -i 's/^SOB_TAG=.*/SOB_TAG=0.1.1/' .env
docker compose -f compose.prod.yaml up -d --build --wait
```

Migrations run first and are forward-only; if one fails the old containers keep running. Rollback and destructive-migration guidance: [operations.md](operations.md#4-upgrades-migrations-and-rollback).

Pre-built images (published by the release workflow, not yet exercised by the project maintainers): pull `ghcr.io/<owner>/<repo>-api:<version>` and `-web`, retag them as `sob-api:<version>` and `sob-web:<version>`, and start with `docker compose -f compose.prod.yaml up -d --no-build --wait`.

## 8. The desktop client

The Linux front-desk app (`apps/desktop`) points at your site: `SOB_API_URL=https://salon.example`. It signs in with an owner or staff account and works offline, syncing when the connection returns. See [apps/desktop/README.md](../apps/desktop/README.md); there is no packaged installer in 0.1.0 beyond the release workflow's best-effort Linux archive.

## 9. Troubleshooting

| Symptom                                                                   | Look at                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` fails with "set POSTGRES_PASSWORD" / "set PUBLIC_URL" | The `.env` file is missing a required variable, or you are not in the directory that holds it.                                                        |
| API container restarts, log says `Invalid environment configuration`      | The message lists every problem: secret shorter than 32 characters, missing `SMTP_URL`, verification required with no provider.                       |
| Cannot sign in, page reloads on submit                                    | Cookies are `Secure`: you must use https (or `localhost`). Check that `PUBLIC_URL` is exactly the address in the browser bar.                         |
| Sign-up "check your inbox" but nothing arrives                            | SMTP credentials or sender domain (spam folder, SPF/DKIM). Log line `account email failed`.                                                           |
| Caddy cannot get a certificate                                            | DNS not pointing at the server yet, ports 80/443 closed, or another service holds them. `docker compose ... logs caddy`.                              |
| Everybody gets 429 "rate_limited"                                         | All visitors share one address: the proxy does not append `X-Forwarded-For`, or `WEB_TRUST_PROXY` is wrong.                                           |
| `/ready` is 503                                                           | The body names `database` or `valkey`; check that container's health and logs.                                                                        |
| Reminders never go out                                                    | Worker not running (`ps`), no provider configured, or the appointment is not yet inside a reminder window; `GET /admin/notifications/stats` as owner. |
| "Slot taken" when two people book at once                                 | Normal: the database constraint decided who was first.                                                                                                |
| Disk fills up                                                             | Docker logs rotate (10 MB x 5); Postgres growth is the sync log and reminders, trimmed daily by housekeeping.                                         |

Still stuck? Open an issue with the `X-Request-Id` of the failing request and the relevant JSON log lines (no secrets), or follow [SECURITY.md](../SECURITY.md) if it is a vulnerability.
