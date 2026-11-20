# Security review and dependency inventory (release 0.1.0)

Status as of 2026-11-15, commit range up to the 0.1.0 release candidate. This is a self-review plus automated advisory scans, **not** an independent audit or a penetration test. Report vulnerabilities through [SECURITY.md](../SECURITY.md).

## 1. Advisory scans

### JavaScript (`bun audit`, Bun 1.4.5-canary.1, 2026-11-15)

| Scope              | Result                                        |
| ------------------ | --------------------------------------------- |
| `bun audit --prod` | No vulnerabilities (269 production packages). |
| `bun audit` (all)  | No vulnerabilities (436 checked packages).    |

The previously accepted transitive esbuild advisory is resolved by the exact root override `esbuild: 0.28.2`. Migration generation, production builds, unit/integration tests and the pinned Bun 1.4.4 Docker build/smoke were checked with that override. Keep the pin until upstream tooling resolves its old transitive dependency, then remove it with those same checks.

On 2026-11-18, `bun audit` reported one high-severity advisory for `picomatch@4.0.7`. TanStack Start and Vite use it at build time. Vite bundles the Start runtime when compiling the web client and server. Declaring Start as a build dependency removed `picomatch` from the production dependency tree. The production smoke test verified that the web container ships without `picomatch`, the Start build plugin or Vite. The complete smoke suite and a browser check against that image passed. `bun audit --production` checked 239 packages and reported zero advisories. The build dependency remains on the affected version pending an upstream fix. [CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

### Rust (`cargo audit` 0.23.0, advisory database of 2026-11-14, 738 crates in `apps/desktop/Cargo.lock`)

**0 vulnerabilities, 16 warnings.** All 16 are transitive dependencies of `gpui` 0.2.2 (pinned exactly, [ADR 0008](adr/0008-desktop-client.md)); none is a direct dependency of `sob-core` or `sob-desktop`.

| Advisory                                                      | Crate(s)                                                                      | Kind         | Triage                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUSTSEC-2026-0183, RUSTSEC-2026-0184                          | `git2` 0.20.4 (via `gpui_util`, `gpui_http_client`)                           | unsound      | `Remote::list()` and `BlameHunk` signature misuse. The desktop client never calls any git API; the crate is linked by GPUI only. Fix needs `git2` >= 0.21: wait for a GPUI release. |
| RUSTSEC-2026-0370 / 0371 / 0372                               | `zvariant`, `zbus_names`, `zvariant_derive` (via `oo7`, D-Bus secret service) | unmaintained | D-Bus plumbing GPUI uses on Linux. No known vulnerability; track the upstream replacement.                                                                                          |
| RUSTSEC-2026-0192                                             | `ttf-parser` 0.20.0, 0.21.1, 0.25.1                                           | unmaintained | Font parsing of fonts shipped with the OS or the app, not of untrusted input.                                                                                                       |
| RUSTSEC-2026-0206                                             | `rustybuzz` 0.14.1, 0.20.1                                                    | unmaintained | Text shaping, same exposure as above.                                                                                                                                               |
| RUSTSEC-2025-0052                                             | `async-std` 1.13.2                                                            | unmaintained | Discontinued runtime pulled by GPUI.                                                                                                                                                |
| RUSTSEC-2024-0384, 2024-0436, 2025-0134, 2026-0173, 2026-0441 | `instant`, `paste`, `rustls-pemfile`, `proc-macro-error2`, `pin-utils`        | unmaintained | Build-time macros or small utilities; no advisory describes an exploitable defect.                                                                                                  |

Action: re-run `cargo audit` on every GPUI bump (Dependabot ignores GPUI minor and major updates on purpose) and in the release checklist. `cargo audit` is not part of CI yet; adding `rustsec/audit-check` is a cheap follow-up.

## 2. Dependency and license inventory

Generated from the installed trees (JavaScript: every `package.json` under `node_modules/.bun`; Rust: `cargo metadata --locked`, all targets). The project itself is MIT-licensed ([LICENSE](../LICENSE)); every dependency license below is compatible with distributing MIT software.

### JavaScript (346 packages)

| License                                                            | Packages | Notes                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT                                                                | 288      |                                                                                                                                                                                          |
| ISC                                                                | 24       |                                                                                                                                                                                          |
| Apache-2.0                                                         | 10       |                                                                                                                                                                                          |
| BSD-3-Clause / BSD-2-Clause                                        | 7 / 2    |                                                                                                                                                                                          |
| MPL-2.0                                                            | 4        | `lightningcss` (Tailwind build tool) and `axe-core`, `@axe-core/playwright` (tests). File-level copyleft, unmodified, **not in the runtime images**.                                     |
| OFL-1.1                                                            | 2        | `@fontsource-variable/fraunces`, `@fontsource-variable/inter`: fonts served by the web app (the license permits bundling and redistribution; keep the license text with the font files). |
| MIT OR Apache-2.0                                                  | 2        | Biome.                                                                                                                                                                                   |
| MIT-0                                                              | 2        | `nodemailer` (runtime, SMTP), `smtp-server` (tests).                                                                                                                                     |
| BlueOak-1.0.0, Python-2.0, Unlicense, MIT AND ISC AND BSD-3-Clause | 1 each   | `graceful-fs`, `argparse`, `isbot`, `victory-vendor` (charts).                                                                                                                           |
| CC-BY-4.0                                                          | 1        | `caniuse-lite` (data used by build tooling, not shipped).                                                                                                                                |

No GPL, AGPL or SSPL package, no unknown or missing license field.

### Rust (738 crates, desktop client only)

About 95 percent are MIT, Apache-2.0 or dual-licensed MIT/Apache-2.0 (including `Unlicense OR MIT`, `Zlib OR ...`). The rest, with attention points:

| License expression                                                                   | Crates                             | Note                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unicode-3.0 (18), BSD-2/3-Clause (14), ISC (6), Zlib (5), CC0-1.0 (3), 0BSD, BSL-1.0 | various                            | Permissive.                                                                                                                                      |
| MPL-2.0                                                                              | `cbindgen`, `dwrote`, `option-ext` | File-level copyleft; used unmodified. Source for those files is available from upstream.                                                         |
| `Apache-2.0 OR GPL-2.0-only`                                                         | `self_cell`                        | Choose Apache-2.0.                                                                                                                               |
| `MIT OR Apache-2.0 OR LGPL-2.1-or-later`                                             | `r-efi`                            | Choose MIT.                                                                                                                                      |
| CDLA-Permissive-2.0                                                                  | `webpki-roots`                     | Data license, permissive.                                                                                                                        |
| `(MIT OR Apache-2.0) AND NCSA`                                                       | `libfuzzer-sys`                    | Fuzzing harness crate that appears in the lock file; whether it reaches the shipped binary was not checked (it is a test-only crate by purpose). |

There is one vendored crate, `apps/desktop/vendor/xattr`, carrying a one-line compile patch ([ADR 0008](adr/0008-desktop-client.md)); its upstream license (MIT OR Apache-2.0) applies.

### Container images

Base images: `oven/bun:1.4.4-slim` (Debian, mixed licenses), `postgres:18-alpine`, `valkey/valkey:9.1-alpine` (BSD-3-Clause), `caddy:2.10.2-alpine` (Apache-2.0), `axllent/mailpit` (dev only, MIT). The release workflow attaches an SBOM and provenance attestation to each published image so the OS-level inventory is machine readable (unverified until the first release runs).

## 3. Self-review of the security design

What exists and is covered by automated tests (details in the ADRs):

- **Authentication and sessions** (ADR 0003, 0011): Better Auth with scrypt hashes, HttpOnly SameSite=Lax Secure cookies, Valkey-backed sessions, email verification, single-use one-hour reset links that revoke other sessions, no user enumeration on sign-up, reset and verification, per-address email throttle, strict rate limits on auth endpoints.
- **Authorization**: one policy matrix (owner, staff, client) applied by REST, sync and MCP through the same service layer; tests assert a client token never sees another client's data.
- **Double booking**: enforced by a Postgres exclusion constraint, proven under 50-way contention by the k6 scenario and its SQL check.
- **Web**: nonce-based CSP without `unsafe-inline` for scripts, `frame-ancestors 'none'`, HSTS on https, origin checks on cookie-authenticated mutations, same-origin proxy (no CORS), the metrics endpoint never routed publicly.
- **OAuth 2.1 and MCP** (ADR 0009): PKCE `S256` mandatory, short-lived audience-bound JWTs, rotating refresh tokens with reuse detection, consent per scope, grant audit log, rate limits on registration.
- **Secrets and logging**: `*_FILE` secrets, key-name and pattern redaction in logs, query strings and addresses not logged.
- **Deployment**: non-root read-only containers with all capabilities dropped, no published database ports, resource limits.
- **Backups** are checksummed and restore refuses a non-empty target.

## 4. What was not done

Be clear about the limits of this review:

- No external audit, penetration test, DAST scan (ZAP, Burp), SAST tool run or fuzzing of the API.
- No review of the Better Auth, Hono, TanStack or GPUI source; they are trusted at the pinned versions and covered only by the advisory scans above.
- `cargo audit` and `bun audit` cover known advisories only; `cargo deny` and a license gate are not in CI.
- Container image vulnerability scans (Trivy, Grype) were not run against the built images.
- The desktop client stores its session in a mode-0600 file, not the OS keyring (known gap).
- Residual risks documented elsewhere: self-asserted OAuth client names (phishing of consent, ADR 0009), no MFA, no account lockout beyond rate limiting, account-email delivery is at least once; a crash after SMTP acceptance can duplicate mail. Pending payloads are encrypted and terminal payloads are erased (ADR 0011).

## 5. Recommended follow-ups before a 1.0

1. Add `cargo audit` (and `bun audit --prod`) to CI as non-blocking jobs, blocking on new vulnerabilities.
2. Scan the published images with Trivy in the release workflow.
3. MFA for the owner account.
4. OAuth login for the desktop client and OS keyring storage, then drop the cookie path for `/sync/*` from the desktop's needs.
5. An independent review of the OAuth and sync endpoints.
