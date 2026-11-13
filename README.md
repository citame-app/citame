# Sisters of Beauty

Open-source booking and salon-management platform (a Booksy alternative): online booking for clients, calendar and CRM for the salon, reminders, and an offline-capable desktop client for the front desk. Self-hosted with Docker.

The project is built in phases. See [docs/PLAN.md](docs/PLAN.md) for scope, architecture and roadmap, and [docs/adr](docs/adr) for decision records.

## Quickstart

Requirements: [Bun](https://bun.sh) 1.4+, Docker with Compose.

```sh
cp .env.example .env          # then set BETTER_AUTH_SECRET
bun install
docker compose up -d postgres valkey
bun run dev                   # API on http://localhost:3000/health
```

## Common commands

```sh
bun run typecheck   # tsc across workspaces (via Turborepo)
bun run lint        # Biome
bun run test        # bun test
docker compose up -d --build   # full stack (postgres, valkey, api)
```

## Layout

- `apps/api`: Hono API on Bun
- `packages/contracts`: shared Zod schemas
- `packages/db`: Drizzle schema and migrations
- `packages/config`: shared TypeScript config
