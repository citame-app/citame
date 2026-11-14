# Load and contention tests (k6)

k6 2.x scripts in plain JavaScript. They talk to a running stack (compose or local processes) with a migrated, seeded database. Results measured on a real run are in [docs/performance.md](../docs/performance.md).

| Script                  | What it proves                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability.js`       | Read-heavy browsing (catalogue + slot search), ramping VUs. Thresholds: p95 < 300 ms for slot search, < 150 ms for the catalogue, < 1 % errors.                                                                                                                     |
| `booking-contention.js` | `VUS` users (default 50) race for the **same** slot, for `ROUNDS` (default 10) different slots. Thresholds: exactly one `201` per slot, every other answer `409 slot_taken`, no other status, and a teardown check that each slot has exactly one live appointment. |
| `check-overlaps.ts`     | SQL proof after the run: no two non-cancelled appointments of one staff member overlap.                                                                                                                                                                             |
| `mixed.js`              | Smoke-sized mixed workload (browsers, front-desk calendar and sync pull, `/ready` probes).                                                                                                                                                                          |

## Running

```sh
docker compose up -d --wait postgres valkey && bun run db:migrate && bun run db:seed
# API with the limits out of the way (k6 is one IP) and the first owner:
export BETTER_AUTH_SECRET=... OWNER_EMAIL=owner@example.com OWNER_PASSWORD='a long passphrase'
bun run bootstrap:owner
RATE_LIMIT_GLOBAL_MAX=1000000 bun apps/api/src/index.ts &

bun run k6:availability
K6_EMAIL=$OWNER_EMAIL K6_PASSWORD=$OWNER_PASSWORD bun run k6:contention   # k6 run + SQL check
K6_EMAIL=$OWNER_EMAIL K6_PASSWORD=$OWNER_PASSWORD bun run k6:mixed
```

Environment: `BASE_URL` (default `http://localhost:3000`, the API), `API_PREFIX` (`/api` when `BASE_URL` is the web origin, whose proxy forwards to the API), `ORIGIN` (the `Origin` header sent with mutations; set it to the web origin, e.g. `http://localhost:4173`, when the API was started with `BETTER_AUTH_URL` pointing there), `K6_EMAIL` / `K6_PASSWORD` (an owner; bookings are made as the owner), `VUS`, `DURATION`, `ROUNDS`, and for `availability.js` `SLEEP=0` to drop the think time and measure saturation.

Notes:

- The global rate limiter is per client address (300 requests per minute by default). A load generator is one address, so raise `RATE_LIMIT_GLOBAL_MAX` for the run; never do that in production.
- The contention test creates real appointments (and one client, `k6-load@example.com`). Use a scratch database.
- Slots are discovered through the real availability endpoint, so the test needs free future slots for the first seeded stylist.
