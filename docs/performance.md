# Performance

All numbers below were measured, not estimated. They describe one development machine and one run each; treat them as an order of magnitude and a regression baseline, not a capacity promise.

## Machine and setup

- Linux 7.0 (Ubuntu), Intel Core i7-8565U (4 cores / 8 threads, 1.8 GHz base, a laptop CPU), 14 GB RAM, NVMe disk. k6 2.2.0, Bun 1.4, Postgres 18 and Valkey 9.1 in Docker (default settings), API and web as local production-mode Bun processes (`NODE_ENV=production`, `RATE_LIMIT_GLOBAL_MAX=1000000`). **k6, API, web, Postgres and Valkey all shared the same 8 CPUs**, which understates what a separate load generator would see.
- Database: fresh, migrated and seeded (3 services, 2 stylists). Scenarios are in [k6/](../k6/README.md).

## Booking contention (the correctness test)

Every virtual user fires one `POST /appointments` for the same slot at the same moment; repeated for several slots.

| Run | Racers per slot | Slots | `201` | `409 slot_taken` | Other | p95 booking latency | DB overlap check |
| --- | --- | --- | --- | --- | --- | --- | --- |
| API direct | 50 | 10 | **10** (exactly 1 per slot) | 490 | 0 | 261 ms (avg 165 ms) | 0 overlapping pairs, 10 live appointments |
| Through the web proxy | 200 | 20 | **20** (exactly 1 per slot) | 3 980 | 0 | 619 ms (avg 527 ms) | 0 overlapping pairs, 30 live appointments |

All thresholds passed, including the teardown check that each raced slot has exactly one live appointment. The exclusion constraint, not application code, decides the winner: the losers are answered `409 slot_taken` without a stack trace or a 500. Latency grows with the number of simultaneous racers because the losing inserts queue behind the winner's row lock; it is not a throughput limit (a realistic salon sees a handful of concurrent bookings).

## Availability (the read-heavy path)

| Scenario | Load | p95 slot search | p95 catalogue | Errors | Throughput |
| --- | --- | --- | --- | --- | --- |
| Realistic browsing, API direct | 50 VUs, ~1 s think time | 2.5 ms | 1.6 ms | 0 % of 7 118 | 127 req/s (limited by think time) |
| Realistic browsing, via the web proxy | 50 VUs, ~1 s think time | 2.7 ms | 1.9 ms | 0 % of 7 157 | 128 req/s |
| Saturation, API direct | 100 VUs, no think time | 79 ms | 38 ms | 0 % of 155 276 | **2 823 req/s** (CPU shared with k6) |

Mixed smoke (20 browsers, 2 front-desk users reading the calendar and `/sync/pull`, 5 `/ready` probes/s, 30 s): p95 9 ms overall, `/ready` p95 1.5 ms, 0 % errors, 1 473 requests.

**Bottlenecks found: none.** The slot search issues a handful of indexed queries (settings, services, qualified staff, then working hours, time off and appointments in parallel; `appointment_staff_starts_idx` covers the window scan) and there is no N+1. No index or query changes were made because nothing measured called for one. Saturating at roughly 2.8k req/s with the load generator on the same machine leaves large headroom over a salon's traffic.

## Web (Lighthouse)

See the section at the end of this file.

## Caveats

- Single machine, single run per scenario, local loopback (no network latency, no TLS).
- Bookings were made as the owner to avoid creating thousands of client accounts; the booking transaction is the same for clients.
- The DB pool is the default 10 connections per process; the 200-racer run was served by one API process.
- Numbers will differ on your hardware, with a remote database, or with a larger catalogue and appointment history. Re-run `bun run k6:*` after changes that touch the booking or availability path.
