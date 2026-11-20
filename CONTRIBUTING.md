# Contributing

Thanks for helping. This guide covers setup, how we work, and what a pull request needs. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

Read [docs/PLAN.md](docs/PLAN.md) (scope and architecture) and the [ADRs](docs/adr) first: they explain why things are the way they are, and a change that contradicts one needs a new ADR.

## Setup

Requirements: [Bun](https://bun.sh) 1.4.4, Docker with Compose, and for the desktop client Rust (the exact toolchain is pinned in `apps/desktop/rust-toolchain.toml`, installed by `rustup`).

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres valkey     # add `--profile mail` for Mailpit on :8025
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
bun run db:migrate && bun run db:seed
OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-please' bun run bootstrap:owner
bun run dev                                     # API :3000, web :5173
```

Layout: `apps/api` (Hono), `apps/web` (TanStack Start), `apps/desktop` (Rust, GPUI), `packages/{contracts,db,config}`, `k6/`, `scripts/`, `docs/`. See the README for details and the full environment reference in [docs/env-reference.md](docs/env-reference.md).

## Workflow: test first

1. Open or pick an issue; for anything larger than a small fix, say what you intend to do before you start.
2. Write the failing test first and watch it fail for the right reason. Integration tests run against the real Postgres and Valkey from compose (no database mocks); they create their own `sob_test_*` databases.
3. Make it pass with the smallest change, then refactor with the tests green.
4. Keep every contract in `packages/contracts` (Zod) as the single source of truth for API shapes. Business rules live in the service layer so REST, sync and MCP share them.
5. Add or update the docs that the change touches (README table, ADR, `docs/*.md`).

Conventions: TypeScript strict, Biome for lint and format (`bun run format`), exact dependency versions (no `^` or `~`), English for code, comments, docs and UI source strings; translations (`es-AR`, neutral) live next to them in `apps/web/src/i18n`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary` with `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`. Examples: `fix(api): map slot_taken on the sync path`, `docs(ops): explain secrets rotation`. Keep commits small and reviewable, each with its tests and docs. Do not add AI or co-author trailers.

## Running the checks

```sh
bunx turbo run typecheck lint test build     # everything TypeScript (needs compose postgres + valkey)
bun run test:scripts                         # backup/restore round trip
```

End-to-end (Playwright, real stack, fresh database; the README's "End-to-end tests" section has the full server start-up and the Mailpit requirement):

```sh
cd apps/web && bunx playwright install chromium
E2E_OWNER_EMAIL=... E2E_OWNER_PASSWORD='correct horse battery staple' bun run e2e
```

For checkout and finance changes, the README also documents [isolated E2E suites](README.md#end-to-end-tests) with seeded credentials.

Load and contention tests ([k6/README.md](k6/README.md)): `bun run k6:contention` must end with exactly one 201 per slot and zero overlaps.

Desktop (from `apps/desktop`):

```sh
cargo fmt --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The build directory is large (a debug GUI build is about 2 GB): `cargo clean` when you are done. Headless sync tests against a real API are described in [apps/desktop/README.md](apps/desktop/README.md).

Production images and the smoke test: `scripts/smoke-prod.sh` (see [docs/operations.md](docs/operations.md)).

## Screens and visual changes

UI changes need a look at the result in light and dark, English and Spanish, at phone and desktop width. Run the screenshot specs (`bunx playwright test screenshots`), open the images, and note anything you fixed in your PR. [docs/visual-qa.md](docs/visual-qa.md) shows the review checklist we use.

## Pull request checklist

- [ ] A failing test existed first, and the change has tests at the right level.
- [ ] `bunx turbo run typecheck lint test build` is green; Playwright and `cargo` checks run if you touched web or desktop.
- [ ] Docs, ADR or CHANGELOG updated when behavior, configuration or operations change (add under "Unreleased").
- [ ] New environment variables are in `apps/api/src/config.ts` and `docs/env-reference.md`.
- [ ] Migrations are forward-only SQL files in `packages/db/drizzle` (never edit an applied one), and the exclusion-constraint guarantees still hold.
- [ ] No secrets, personal data or generated build output in the diff.
- [ ] Commits follow Conventional Commits.

## Reviews and releases

Maintainers review for correctness, tests, security, accessibility and docs. Releases are tagged `vX.Y.Z` from `main`; the [release workflow](.github/workflows/release.yml) builds the images and publishes the notes from the CHANGELOG.
