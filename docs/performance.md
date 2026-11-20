# Performance

All numbers below were measured, not estimated. They describe one development machine and one run each; treat them as an order of magnitude and a regression baseline, not a capacity promise.

## Machine and setup

- Linux 7.0 (Ubuntu), Intel Core i7-8565U (4 cores / 8 threads, 1.8 GHz base, a laptop CPU), 14 GB RAM, NVMe disk. k6 2.2.0, Bun 1.4, Postgres 18 and Valkey 9.1 in Docker (default settings), API and web as local production-mode Bun processes (`NODE_ENV=production`, `RATE_LIMIT_GLOBAL_MAX=1000000`). **k6, API, web, Postgres and Valkey all shared the same 8 CPUs**, which understates what a separate load generator would see.
- Database: fresh, migrated and seeded (3 services, 2 stylists). Scenarios are in [k6/](../k6/README.md).
- **Rate limits were effectively off for these runs.** The global limiter (300 requests per minute per client address by default) was raised to 1 000 000 because k6 is a single address. Production numbers for one visitor are bounded by the real limit. Server-rendered pages call the API on behalf of the visitor and forward their address (`X-Forwarded-For`, set by the web server), so each visitor has their own bucket; before that fix every SSR call shared the web container's bucket.

## Booking contention (the correctness test)

Every virtual user fires one `POST /appointments` for the same slot at the same moment; repeated for several slots.

| Run                   | Racers per slot | Slots | `201`                       | `409 slot_taken` | Other | p95 booking latency | DB overlap check                          |
| --------------------- | --------------- | ----- | --------------------------- | ---------------- | ----- | ------------------- | ----------------------------------------- |
| API direct            | 50              | 10    | **10** (exactly 1 per slot) | 490              | 0     | 261 ms (avg 165 ms) | 0 overlapping pairs, 10 live appointments |
| Through the web proxy | 200             | 20    | **20** (exactly 1 per slot) | 3 980            | 0     | 619 ms (avg 527 ms) | 0 overlapping pairs, 30 live appointments |

All thresholds passed, including the teardown check that each raced slot has exactly one live appointment. The exclusion constraint, not application code, decides the winner: the losers are answered `409 slot_taken` without a stack trace or a 500. Latency grows with the number of simultaneous racers because the losing inserts queue behind the winner's row lock; it is not a throughput limit (a realistic salon sees a handful of concurrent bookings).

## Availability (the read-heavy path)

| Scenario                              | Load                    | p95 slot search | p95 catalogue | Errors         | Throughput                           |
| ------------------------------------- | ----------------------- | --------------- | ------------- | -------------- | ------------------------------------ |
| Realistic browsing, API direct        | 50 VUs, ~1 s think time | 2.5 ms          | 1.6 ms        | 0 % of 7 118   | 127 req/s (limited by think time)    |
| Realistic browsing, via the web proxy | 50 VUs, ~1 s think time | 2.7 ms          | 1.9 ms        | 0 % of 7 157   | 128 req/s                            |
| Saturation, API direct                | 100 VUs, no think time  | 79 ms           | 38 ms         | 0 % of 155 276 | **2 823 req/s** (CPU shared with k6) |

Mixed smoke (20 browsers, 2 front-desk users reading the calendar and `/sync/pull`, 5 `/ready` probes/s, 30 s): p95 9 ms overall, `/ready` p95 1.5 ms, 0 % errors, 1 473 requests.

**Bottlenecks found: none.** The slot search issues a handful of indexed queries (settings, services, qualified staff, then working hours, time off and appointments in parallel; `appointment_staff_starts_idx` covers the window scan) and there is no N+1. No index or query changes were made because nothing measured called for one. Saturating at roughly 2.8k req/s with the load generator on the same machine leaves large headroom over a salon's traffic.

## Web (Lighthouse)

See the section at the end of this file.

## Caveats

- Single machine, single run per scenario, local loopback (no network latency, no TLS).
- Bookings were made as the owner to avoid creating thousands of client accounts; the booking transaction is the same for clients.
- The DB pool is the default 10 connections per process; the 200-racer run was served by one API process.
- Numbers will differ on your hardware, with a remote database, or with a larger catalogue and appointment history. Re-run `bun run k6:*` after changes that touch the booking or availability path.

### Release-readiness recheck (2026-11-15)

On the same host, with a fresh scratch database, 50 racers across 10 slots again produced exactly 10 creates, 490 `409 slot_taken` responses and no unexpected responses. The SQL overlap check remained zero, including after the desktop's four real-API offline-sync tests. Booking p95 was 784 ms, passing the unchanged 1,000 ms threshold. This run used the host's Bun 1.4.5 canary; the production-image smoke test separately passed on pinned Bun 1.4.4.

An earlier run during simultaneous API tests and Rust compilation preserved correctness but failed the latency threshold (p95 2.83 s). The recheck followed completion of the API suite and GPUI build; Playwright was still running. These measurements include competing local work and are not isolated capacity benchmarks. No threshold was relaxed and no booking-path optimization was claimed.

### Lighthouse (mobile preset, performance category, Lighthouse 13.6, production build)

Measured against the production-mode stack on the machine above, signed in as the owner for the admin pages (the cookie is sent as a header; the calendar URL includes `?view=day` so the redirect to it does not drop it). Five runs per page; the median is shown.

| Page                              | Default throttling (4x CPU): score, TBT | 6x CPU slowdown: score, TBT | Transfer |
| --------------------------------- | --------------------------------------- | --------------------------- | -------- |
| `/admin`                          | 96, 215 ms                              | 90, 396 ms                  | 387 kB   |
| `/admin/calendar?view=day`        | 97, 187 ms                              | 89, 456 ms                  | 401 kB   |
| `/book/time?services=..&staff=..` | 99, 146 ms                              | 87, 527 ms                  | 394 kB   |

LCP is about 750 ms on every page at both settings (the first paint is server-rendered HTML plus the CSS), CLS 0 except 0.015 on the calendar.

**Honest status of the earlier numbers (calendar 79, `/admin` 88, `/book/time` 92 with a ~525 kB bundle).** They could not be reproduced: on the same code the pages score 96 to 99 at default throttling and 87 to 90 with a harsher 6x slowdown, and the transfer is 387 to 401 kB because the Recharts chunk (393 kB) is its own route chunk and is not loaded outside `/admin/reports`. Run-to-run noise is large (TBT of one page ranged 240 to 990 ms across identical runs), so differences of a few points are not evidence.

**What was tried, and why nothing was kept.** The calendar's appointment drawer, new-appointment sheet and shortcut help were moved behind `React.lazy` (they are only needed after a click). The transfer for the calendar fell by 6 kB (401 to 395 kB) but the median score and TBT did not move beyond noise (6x slowdown: 89 before, 86 after, with TBT swinging 350 to 880 ms between runs), and it removes the drawer's exit animation. It was reverted rather than claimed as a win. What remains in the critical path is the shared entry chunk (about 128 kB gzip: React, the router, TanStack Query and the Zod contracts), not route code; shrinking it means replacing Zod on the client with a lighter validator, which is a larger change than this phase.

The route-level splitting TanStack Start already performs, the nonce CSP (no inline-script penalty) and long-lived immutable asset caching are in place; the CSP and the extra headers added in this phase do not show up in the numbers (the pre-CSP pages were not re-measured for comparison, so there is no before/after for that change).

### React rendering and navigation recheck (2026-11-17)

The built web app was checked in Chromium on localhost with synthetic data, fresh browser contexts and 4× CPU throttling. Each cell describes one local observation. The observer excludes layout shifts associated with recent user input.

| Screen                  | 390 px initial CLS / LCP | 1440 px initial CLS / LCP |
| ----------------------- | ------------------------ | ------------------------- |
| Home                    | 0 / 460 ms               | 0 / 176 ms                |
| Choose booking services | 0 / 180 ms               | 0 / 140 ms                |
| Calendar                | 0 / 268 ms               | 0 / 248 ms                |
| Reports                 | 0 / 852 ms               | 0 / 692 ms                |

The original local preview showed a desktop calendar shift of 0.0078 when the staff list loaded. A second audit reproduced the booking catalog moving as the combinations section loaded and the reports toolbar moving as the currency picker appeared. The calendar now renders its first range, staff and waitlist count from the guarded loader. Booking combinations load with the first services screen. Currency selection keeps its place in the reports toolbar while the result loads.

A separate check delayed the browser's range request by 700 ms. In the private calendar, the consultation banner, read-only controls and toolbar position stayed stable while the selected date loaded. The first paint for the copied day showed the 34 expected cards and Chromium reported no hydration errors in Spanish after the time-format normalization.

Path changes use a short native workspace transition. Date and view changes keep their direct response. Chromium was checked with normal motion, reduced motion and the native transition API disabled. Navigation restored focus to the main region in each mode.

Reports now loads the chart module (about 110 kB gzip) when a plot gets close to the viewport. At 390 × 550 the module was not requested until scrolling to the plot, which appeared without a layout shift. The chart summary and table are available independently of that module.

These are local observations. At 4× CPU the chart content still produced a 428 ms task in the last desktop report measurement. Field percentiles and performance on other devices remain to be measured.
