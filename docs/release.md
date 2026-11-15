# Release preparation and publication

The current release target is Linux v1, version 0.1.0. Local preparation needs no Git remote, registry account, domain or production credentials. External setup and publication are intentionally pending until those exist.

## Local checks

```sh
bun install --frozen-lockfile
bun run release:check
```

The validator checks the canonical tag, all six JavaScript package versions, the Rust workspace version and a non-empty matching changelog section. It writes `.release/metadata.json` and `.release/notes.md`. Metadata includes the exact source revision and a `dirty` flag; local drafts may be dirty, but GitHub publishing jobs refuse a dirty checkout. Without `GITHUB_REPOSITORY`, image names remain unset. No placeholder repository is required.

To prepare another version, update the manifests and changelog together, then run `RELEASE_TAG=vX.Y.Z bun run release:check`. The validator rejects mismatches, malformed tags and placeholder repository paths. It does not create tags, push commits or publish anything.

## Linux desktop artifact

```sh
(cd apps/desktop && cargo build --release --locked -p sob-desktop)
bash scripts/package-desktop.sh
(cd .release/desktop && sha256sum -c *.sha256)
```

The archive contains the executable, MIT license, desktop usage guide and release metadata. It uses deterministic file ordering, ownership, timestamps and gzip headers. Repackaging the same executable and metadata produces the same checksum. `SOURCE_DATE_EPOCH` can override the default commit timestamp. Build on the target architecture; the packaging script does not cross-compile or bundle Linux system libraries. Installation, OS keyring, auto-update and macOS/Windows distribution remain future work.

## GitHub gate, once a repository exists

The release workflow derives GHCR paths from `GITHUB_REPOSITORY`, checks out the requested tag and validates it before any publication. The validator resolves that tag to a commit SHA. The reusable CI workflow, desktop build, image builds and final release job all check out that immutable revision, including for manual dispatch from another branch; moving a tag cannot change the source between jobs.

Publication requires all of these to succeed:

1. Fresh migrations and seed, bootstrap idempotency, lint, types, tests and production builds.
2. Real backup/restore checks and an isolated production Compose smoke test.
3. Mobile/desktop Playwright coverage, local SMTP account flows and booking contention checks.
4. Rust formatting, Clippy, core/GPUI tests and real-API headless sync.
5. An optimized Linux desktop executable, packaged archive and uploaded checksum artifact.

Only then do the API/web images publish for amd64/arm64 with SBOM/provenance. The final job downloads and verifies desktop checksums and creates or updates the GitHub release with the validated notes and required assets. Native packaging failures cannot silently produce a release without a desktop artifact.

The workflow has not been executed on GitHub because this checkout has no remote. Local tests validate its dependency gates, metadata and packaging; those tests do not prove registry permissions, GitHub hosted runners or real image publication.

## Local verification evidence — 2026-11-15

- API: 686 tests; web: 604; contracts: 113; database: 47; scripts/backup/release: 24.
- Playwright: 175 passed, 3 platform-specific skips, including all six screenshot-capture cases.
- Rust: 104 core and 21 GUI tests, plus 4 headless sync tests against the real API.
- Production smoke: passed on the pinned Bun 1.4.4 images, including migration `0008`, authentication, booking conflicts, proxy isolation and container hardening.
- JavaScript audit: zero reported vulnerabilities in both production and full dependency trees. The older Rust advisory review and its upstream warnings remain documented in [security-review.md](security-review.md).
- Formatting, lint, TypeScript checks, production builds and Clippy: passed.
- Two startup-date regressions cover a salon whose day differs from UTC, including initial catalog synchronization and preservation of explicit dates.
- A GPUI regression first reproduced inaccessible late-week columns at 800 px; horizontal scrolling now keeps day headers aligned with the calendar body.

Real SMTP/SMS delivery, production HTTPS and third-party MCP hosts require the corresponding external accounts/environment. Configure and verify those when available; the repository contains the deployment configuration and local adapters/tests.
