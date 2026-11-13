# ADR 0001: Stack and monorepo

Status: accepted

## Context

Sisters of Beauty needs a self-hostable booking platform with a web app, an API and an offline-capable desktop client for one salon. We want one TypeScript toolchain for server and web, strict end-to-end types, and minimal infrastructure.

## Decisions

- **Bun workspaces + Turborepo.** Bun is the runtime, package manager and test runner. Turborepo is the task runner: it orders tasks across packages, caches `typecheck`, `lint`, `test` and `build`, and provides `turbo prune --docker` for small API images. Exact dependency versions are pinned and `bun.lock` is committed.
- **Hono** for the API: small, Web-standard `fetch` handlers, runs natively on Bun, easy to test with `app.request`.
- **Postgres + Drizzle** for data. Postgres gives us exclusion constraints (`btree_gist`) as the source of truth against double-booking; Drizzle gives typed queries and migrations via drizzle-kit, with hand-written SQL where it cannot express a constraint.
- **Valkey** for sessions (secondary storage), rate limiting, pub/sub fan-out and the reminder queue. Open-source, Redis-protocol compatible.
- **Better Auth** for authentication and, later, as the OAuth 2.1 authorization server used by the MCP server and the desktop client. The version is pinned and its docs are read for that exact version before use.
- **GPUI desktop client** (Rust) for the front desk, with local SQLite and an outbox. GPUI is pre-1.0 and consumed from git, so a commit SHA is pinned. **Rune was rejected** because it is pre-release.
- **Custom sync protocol** (push with idempotent `mutation_id`, pull by monotonic cursor, SSE nudges). One salon and a few devices do not justify ElectricSQL or PowerSync.
- **Recharts** for report charts. This is an assumption: TanStack ships no chart library. Revisit if a better fit appears.
- **Zod contracts** in `packages/contracts` as the single source of truth for API, web and MCP types.

## Consequences

- One language and one lockfile for everything except the desktop client.
- Turborepo adds a small config surface and a build cache; in return CI and Docker builds stay fast.
- GPUI and Better Auth OAuth plugins are moving targets; upgrades are deliberate and pinned.
