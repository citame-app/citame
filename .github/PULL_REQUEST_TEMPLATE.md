## What and why

<!-- The problem this solves and the approach. Link the issue. -->

## How it was tested

<!-- A failing test came first? Which suites ran: turbo typecheck/lint/test/build, Playwright, cargo, k6, smoke-prod. -->

## Checklist

- [ ] A failing test existed first and the change is covered at the right level
- [ ] `bunx turbo run typecheck lint test build` is green (and Playwright / `cargo` if web or desktop changed)
- [ ] Docs, ADR or CHANGELOG ("Unreleased") updated if behavior, configuration or operations changed
- [ ] New environment variables are in `apps/api/src/config.ts` and `docs/env-reference.md`
- [ ] UI changes: checked light and dark, English and Spanish, phone and desktop width
- [ ] No secrets or personal data; commits follow Conventional Commits
