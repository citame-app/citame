# Sisters of Beauty

Open-source booking and salon-management platform (a Booksy alternative): online booking for clients, calendar and CRM for the salon, reminders, and an offline-capable desktop client for the front desk. Self-hosted with Docker.

The project is built in phases. See [docs/PLAN.md](docs/PLAN.md) for scope, architecture and roadmap, and [docs/adr](docs/adr) for decision records.

## Quickstart

Requirements: [Bun](https://bun.sh) 1.4+, Docker with Compose.

```sh
cp .env.example .env                  # then fill in the values it asks for
bun install
docker compose up -d --wait postgres valkey
bun run db:migrate                    # schema + exclusion constraint
bun run db:seed                       # idempotent sample data (generic placeholders)
bun run dev                           # API on http://localhost:3000
```

`DATABASE_URL` defaults to the local compose database. Try it:

```sh
curl localhost:3000/services
curl "localhost:3000/availability?serviceIds=<service-id>&date=2026-03-09"
```

## API (Phase 1)

| Method | Path                                                    | Purpose                                                                  |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/services`                                             | Active service catalog                                                   |
| GET    | `/staff`                                                | Active staff and the services they perform                               |
| GET    | `/availability?serviceIds=a,b&staffId=&date=YYYY-MM-DD` | Bookable slots (`staffId` optional)                                      |
| POST   | `/appointments`                                         | Book (409 `slot_taken` on overlap)                                       |
| PATCH  | `/appointments/:id`                                     | Reschedule or cancel with the current `version` (409 `version_conflict`) |
| GET    | `/appointments?from=&to=&staffId=`                      | List appointments in a range                                             |

Errors always look like `{ "error": { "code", "message" } }`. **Authentication is not implemented yet**: all routes are open until Phase 2 adds RBAC (see the marker in `apps/api/src/app.ts`). Do not expose this build publicly.

## Common commands

```sh
bun run typecheck   # tsc across workspaces (via Turborepo)
bun run lint        # Biome
bun run test        # bun test; integration tests need the compose postgres
bun run db:generate # drizzle-kit: generate a migration from schema changes
docker compose up -d --build   # full stack (postgres, valkey, api)
```

Integration tests create their own `sob_test_*` databases on the server in `DATABASE_URL` and fail loudly if Postgres is unreachable.

## Layout

- `apps/api`: Hono API on Bun (`src/modules/*`: services, staff, availability, appointments)
- `packages/contracts`: shared Zod schemas and the error shape
- `packages/db`: Drizzle schema, migrations (including the hand-written exclusion constraint), seed
- `packages/config`: shared TypeScript config
