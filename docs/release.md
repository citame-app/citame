# Release preparation and publication

The release workflow prepares Linux x86_64 and macOS 15+ builds for Intel and Apple Silicon, version 0.1.0. Local preparation needs no Git remote, registry account, domain or production credentials. Publishing from GitHub requires the release tag, registry access, and the configured macOS signing environment.

## Local rehearsal for 2026-11-23

Revision `2e99b97` restored the encrypted archive in an isolated database and verified 1,053 archived artifacts, 106 native tables and 113 migrations. The Monday agenda contained 38 lines across 33 visits, two staff blocks and 38 resource assignments. A resource-backed reschedule propagated in real time through both web and desktop APIs. The rehearsal checked stale-version rejection, idempotent replay and device revocation. The archive fingerprint matched and the receipt retains `canCutOver: false`.

The local web gateway and the installed Linux SQLite replica matched all 38 lines by ID, professional, time, status and version. The local checkout queue showed the same 38 lines. Separate k6 runs used synthetic data through the same-origin proxy with zero HTTP errors across 8,712 requests. Availability p95 was 2.02 ms with up to 50 browsing users. The mixed workload p95 was 9.1 ms with 20 browsing users, two front-desk users and five health probes per second. These are local server measurements on this host.

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

The release CI builds the Linux x86_64 archive on Ubuntu 24.04. The archive contains the executable, per-user installer, application icon, MIT license, desktop usage guide and release metadata. It uses deterministic file ordering, ownership, timestamps and gzip headers. Repackaging the same executable and metadata produces the same checksum. `SOURCE_DATE_EPOCH` can override the default commit timestamp. Build on the target architecture; the packaging script does not cross-compile or bundle Linux system libraries. Extract the verified archive and run `./install.sh` to add Citame to the user’s application menu. Installation replaces the executable, icon and launcher while preserving the separate settings and replica.

From a graphical session, verify the installed executable reaches its first GPUI frame callback:

```sh
bash scripts/verify-desktop-startup.sh "${XDG_DATA_HOME:-$HOME/.local/share}/citame/bin/sob-desktop"
```

The probe opens Citame with a temporary profile and a loopback URL, reports the timing and closes the process. It uses the same callback as the macOS ZIP verification and leaves the operator's profile untouched.

## GitHub publication gate

The release workflow derives GHCR paths from `GITHUB_REPOSITORY` and verifies that the remote tag still points to the commit that triggered the job. The commit must be reachable from `origin/main`. The reusable CI workflow, desktop builds, image builds and final release job check out that same commit. A manual retry must select the release tag as the workflow ref, for example `gh workflow run release.yml --ref v0.1.0 -f tag=v0.1.0`. Configure a GitHub tag ruleset to restrict updates and deletion of release tags. Keep writes to the API and web packages restricted to the release workflow and any account that manages the registry through an approved release procedure.

Publication requires all of these to succeed:

1. Fresh migrations and seed, bootstrap idempotency, lint, types, tests and production builds.
2. Real backup/restore checks and an isolated production Compose smoke test with SMTP, upgrade, restore and native integration enabled. The Rust client exercises offline replay through the production proxy. For review invitations and moderation it uses a linked device restored from disk, renews its expired OAuth credential, and verifies that revocation rejects its bearer. The invitation replay check verifies one persisted delivery and one message in the private SMTP sink.
3. Mobile/desktop Playwright coverage, local SMTP account flows and booking contention checks. The isolated browser fixtures cover publishing flash offers, rechecking booking discounts and approving membership renewal with simulated bank responses.
4. Rust formatting, Clippy, core/GPUI tests and headless sync against the direct API.
5. Native tests and optimized desktop packages for Linux x86_64, macOS Intel and macOS Apple Silicon, with uploaded checksums.

Only then do the API and web jobs build amd64 and arm64 images with SBOM and provenance. They upload by digest, attest that digest and check its signed source before setting the exact version tag. If the version tag already exists, only an image attested by this release workflow for the same Git tag and commit can be reused. The workflow publishes exact version tags and puts both digest references in the notes. Use those references for deployments. [GHCR digest documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

The final job checks each desktop archive's checksum, embedded source revision and signed GitHub attestation. It uploads the six required files to a draft and downloads them again for a byte comparison. It rechecks the remote Git tag and both registry digests before publishing the draft. Pushes and manual dispatches for the same version share one concurrency group. A failed upload or comparison leaves the draft available for retry. For an existing published release, the job verifies the original archives and notes against the checked commit and registry digests. It preserves the signed bytes even when macOS notarization yields different bytes in the retry. Enable immutable releases in the repository settings to lock published assets at the host. [GitHub release integrity](https://docs.github.com/en/enterprise-cloud%40latest/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)

## macOS signing and notarization

The release workflow builds and tests each architecture on its native runner. Public artifacts require a Developer ID Application identity, Hardened Runtime, a trusted timestamp, Apple notarization and a stapled ticket that passes Gatekeeper assessment. The workflow loads credentials into a disposable keychain and checks the app again after extracting the final ZIP. On macOS and Linux, the packaged executable must create an on-disk SQLite replica in a temporary directory, verify a write after reopening it, clean it up and report the packaged version. This check uses no saved profile or server connection. The **macOS desktop verification** workflow builds ad hoc test packages for both architectures without release credentials. [Apple notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution/).

Configure the GitHub Actions environment `macos-release` with these values.

| Value | Kind |
| --- | --- |
| `CITAME_MAC_CERTIFICATE_BASE64` | Secret containing the base64-encoded Developer ID Application PKCS#12 |
| `CITAME_MAC_CERTIFICATE_PASSWORD` | Secret containing the PKCS#12 password |
| `CITAME_MAC_SIGN_IDENTITY` | Variable containing the full `Developer ID Application: …` identity |
| `CITAME_NOTARY_KEY_BASE64` | Secret containing the base64-encoded App Store Connect team API private key |
| `CITAME_NOTARY_KEY_ID` | Variable containing the API key ID |
| `CITAME_NOTARY_ISSUER` | Variable containing the team issuer ID |

Both workflows verify that the metadata inside the final ZIP matches the expected version and clean checkout revision. A manual run of **macOS desktop verification** can also enable `verify_gui`, which unpacks the new ZIP, opens Citame with a temporary profile and requires the packaged app to report its first GPUI frame within 30 seconds. Leave the option off when the runner lacks Metal rendering support. The frame callback is a launch check. Interactive testing on an Intel Mac and an Apple Silicon Mac remains a separate release verification.

The verifier gives its temporary app three seconds to close after sending `SIGTERM`. If the app stays open, it sends `SIGKILL` to the same job and fails verification if the process is still running two seconds later. The signing and launch check in the manual workflow has a five-minute limit.

## Local verification — 2026-11-18

Release checks passed 47 tests on the workflow's Bun 1.4.4 binary. They covered moved tags, tags outside `main`, unsigned and stale assets, and reusing differently notarized published archives. The workflow files passed actionlint. A disposable registry received a synthetic Linux amd64 and arm64 image by digest and served byte-identical OCI index content after promotion to a tag. The Compose configuration resolved the pinned API digest for migration, API, worker and owner bootstrap, and the pinned web digest for the gateway. The ordinary production smoke test passed. The remote tag and macOS release environment are still pending, so GitHub provenance and actual signing await a hosted release run.

The optimized Linux x86_64 archive was extracted and installed in a temporary user directory on Ubuntu 26.04. The SHA-256 check, desktop-entry validation and shared-library checks passed. In one GNOME Wayland session, the installed binary reported a GPUI first-frame callback after 400 ms. The callback measures startup up to a frame request. This local artifact uses the build host’s glibc and is for testing on this machine. The older baseline in CI is a separate build.

A subsequent Linux build passed the new installation check against the binary extracted and installed from the archive. The check rejected a missing temporary directory, verified reopening the on-disk replica with a valid directory, and left the test profile untouched. The installed app reported a first-frame callback after 521 ms in a separate launch with an isolated profile. The desktop accessibility tool did not expose its window tree.

The local candidate passed the full package test commands for API (1,195), web (811) and database (47) on Bun 1.4.4, plus 24 release and packaging tests. The macOS packaging and GitHub publication failure cases use mocked system and GitHub commands on Linux. Native signing and interactive checks on the target Macs require separate evidence.

The Rust browser OAuth check passed through the production Compose proxy with Chromium and a synthetic owner. It covered browser consent and the native loopback return, persistent device key renewal, queued SQLite changes surviving a close and reopen, writes reaching both replicas, and device revocation. The check exercised the native auth and sync code on Linux.

The production smoke suite also ran with `SMOKE_EMAIL=1 SMOKE_UPGRADE=1 SMOKE_DESKTOP=1` against a disposable Compose project. A private SMTP sink received the booking confirmation and reminders. The linked device exported synthetic cancellation and no-show reports and got the same CSV bytes as the web session. The proxy returned 403 for a customer and 401 for the disconnected device. Thirteen Linux headless tests covered offline replay against the production proxy. A deliberately failed migration preserved the running services and the booking. The corrected migration completed before the services were replaced.

The web image passed the same suite after moving TanStack Start to the build dependency group. The smoke check now inspects the running image for the absence of Vite, the Start build plugin and `picomatch`. A browser session on that exact image signed in as the synthetic owner, listed cancellations and no-shows, downloaded and parsed both CSV files, and navigated to the agenda.

The upgrade smoke test built a disposable database to migration `0060`. The online command refused to apply `0061` and left it unchanged. Migration with the writers drained applied the actual remaining migrations. In the running synthetic stack, a failed online migration preserved all service containers and a failed maintenance migration resumed the same API and worker. The successful upgrade activated a new Caddy container, and its logs redacted the synthetic WhatsApp verification token. The script preserved the synthetic booking across both failures and the successful upgrade. [Upgrade procedure](operations.md#4-upgrades-migrations-and-rollback)

The same disposable stack passed with `SMOKE_EMAIL=1 SMOKE_UPGRADE=1 SMOKE_RESTORE=1 SMOKE_DESKTOP=1`. It restored a checksummed archive into a new database and verified API readiness with public ingress and the worker stopped. After reopening, the smoke suite confirmed owner sign-in, the original appointment in the sync replica and the rejection of a stale cancellation from the previous history. It switched back and verified that the appointment row stayed identical in both databases. The gateway returned transient errors during service reconnection. The backup tests include a full table-by-table content comparison and atomic rollback of a truncated archive. [Recovery procedure](operations.md#3-backup-and-restore)

Desktop recovery now fences batches from older server generations. The 90 API sync and configuration tests, 134 desktop core tests and 54 GPUI tests passed. The recovery tests cover a cursor still within the restored log, preservation of queued proposals after SQLite reopens, interrupted snapshot rebuild and stale views or pages arriving from other local connections. Offline work from the previous history is available in Conflicts for manual reconciliation. [Desktop recovery decision](adr/0021-desktop-replica-recovery.md)

The subsequent workspace lint and type checks passed in all four packages. The package suites ran 809 web, 48 database and 161 contract tests successfully. After updating the public salon assertion to expect the online booking pause flag, all 1,207 API tests passed on the pinned Bun 1.4.4 image. A fresh remote CI run for the current changes is still required. [Last recorded CI run on main](https://github.com/citame-app/citame/actions/runs/44041867480)

The local source checkout passed the full production Compose smoke with email, upgrade, restore and desktop checks enabled. PostgreSQL reported 69 migrations and its last entry matched the SHA-256 of `0068_inventory_product_photo.sql`. The production proxy served the synthetic product's versioned JPEG with private cache headers, refused anonymous and customer reads, and invalidated the old URL after removal. The linked owner device and web session both returned one new and one returning client. Customer and revoked-device requests were refused. All 13 real-API Linux offline replay tests passed. The synthetic restore rejected writes from the old history and switched back with the booking intact. The proxy returned a transient 502 during the deliberately failed maintenance upgrade and recovered before the suite continued.

The disposable run used local image IDs `sha256:c6e48272aed3a4fc30cb99c377357fe9262df1798f87691eb36bc7fa748cde59` for the API and `sha256:bc88badeb2b869b29488173efa10e5c5fb2a18969892f4d40a5e2223be0eef53` for the web gateway. The smoke command removed both local tags at shutdown. A signed publication from a clean release commit is still required.

A regression run reproduced a public 502 immediately after a failed maintenance upgrade. After the rollback change, the full Compose smoke passed again with email, upgrade, restore and desktop checks enabled. The first public readiness request after the maintenance failure succeeded and the web process kept the same start time. The script's restart fallback and its failed-probe diagnostic passed the command-level tests. A separate connection reset occurred while switching back from the restored database. The recovery check retried and the suite finished successfully.

The recovery smoke now uses the runbook's ingress reopening command in both directions. In the full Compose run it traced both public readiness requests to the selected Caddy container, passed the first independent public request after each reopening, and verified the database marker on both sides. The synthetic booking survived the switch and return, and the restored stack rejected an update from the previous sync generation. Unit tests also cover a ready response from a different proxy, parallel reopen attempts and a failed private readiness check. [Recovery procedure](operations.md#switch-a-compose-deployment-to-the-restored-database)

The local Linux x86_64 package built from the current working tree passed checksum verification, launcher validation, shared-library resolution and the SQLite installation check in an empty user directory. The packaged executable reached its first-frame callback in a separate launch with an isolated profile. The Linux accessibility tool could see the process but the app did not expose a window tree, so the launch does not verify interactive use. This local archive has dirty-source metadata and is intended for testing.

The local production smoke passed with email, upgrade, restore and desktop enabled after moving invitation creation into the native client. A follow-up disposable run with email and desktop enabled passed all 15 native tests after adding the HTTP `409` and `version_conflict` assertions. Both runs confirmed a single SMTP message after replay. Running either review test without its synthetic fixture returned a failure. These checks preceded hosted CI and publication.

The complete disposable run passed again with the native review tests using linked-device OAuth. Both tests reopened a saved session with an expired access token and renewed it using the device key. The native client replayed the invitation after delivery, the private SMTP sink still had one message, and the proxy rejected each previously valid bearer with HTTP `401` after device revocation. The synthetic sign-in and consent endpoints were exercised over HTTP. The run also passed maintenance rollback and backup recovery with all 15 native proxy tests. A separate run reproduced the documented gateway restart after maintenance failure. Seven checks of the smoke assertions exercised both paths and rejected redirects, undeclared restarts and failed gateway readiness.

The inventory smoke passed with 16 native proxy tests and linked-device OAuth. It verified catalog lookup, pack edits in both directions, native clearing, a stale-version error, a commerce sync revision and unchanged stock. A device bearer could read the catalog and update pack content through its dedicated route. It could not create products, change other fields or read inventory after revocation. The local Linux package passed installation and fetched the synthetic catalog at launch. The application did not expose an AT-SPI window tree for an interactive desktop check.

The email and desktop Compose smoke passed with 18 native integration tests. A web session enabled offers after an OAuth-linked device loaded the imported waitlist request. The server rejected the device's save while offers were enabled and rejected a separate request that omitted the staff preference. With offers paused, the device saved the request for any qualified professional. The web and desktop endpoints returned one linked entry after re-enabling the policy and replaying the same request. A separate API test ran the matching worker with an available slot and verified zero scans, offers and reminders while paused. It also compared the archived request before and after linking and replay. Two GPUI tests covered the import controls, and four browser tests covered the ordinary lifecycle of customer offers on mobile and desktop.

The full CI smoke command with email, desktop, upgrade and restore enabled passed on the same local checkout. It exercised migration rollback, the switch to a separate restored database, rejection of changes queued against the prior history, and the switch back. The disposable containers were removed afterward. The dataset and SMTP sink were synthetic.

The Linux build with the global stock ledger passed its checksum and the extracted application's SQLite test after installation into an isolated directory. The Compose test compared filtered ledger results between the web session and a linked OAuth device and checked CSV filtering, read-only access and revocation. A fresh stack initially exposed a startup race when the PostgreSQL health check accepted the temporary Unix-socket server. After switching the health check to TCP, the disposable Compose test passed with email and desktop enabled.

## Linux GPUI replica smoke — 2026-11-19

The local debug executable passed the SQLite installation check and ran against the built web gateway, a disposable PostgreSQL database and a disposable Valkey instance. The Rust desktop auth code handled PKCE, the loopback callback and device enrollment. A scripted browser-side harness submitted the test account's normal password sign-in and consent. The executable launched through `agent-desktop`, read the linked owner's private session and opened an authenticated SSE stream. Its on-disk replica contained 210 synthetic appointments, including 42 on the selected day, and six professionals.

A block written through the web gateway appeared in the running app's SQLite replica 12 ms after the HTTP response in one local trial. With the gateway stopped, a harness called the same Rust operation as the block editor and queued a second block. GPUI restarted with the saved replica and queued block, reaching its first-frame callback in 452 ms. After the gateway restarted, the running app reopened its stream, pushed the queue and pulled the result. The web endpoint returned one copy of the block, with the expected professional and timestamps. The queue was empty afterward.

AT-SPI reported the running process without an accessibility connection. The test verifies the native executable, persisted replica and both network directions. Interactive calendar rendering, the physical input controls and behavior on the target Macs still need verification.

The build with migration 0074 passed the full Compose smoke with email, desktop, upgrade and restore enabled. The restored ledger kept its movement rows and position. Both the list and CSV endpoints rejected an anchor from the previous database generation. The linked device and web showed the same anchored inventory results. Browser tests covered a movement that committed while a page response was in flight. The import tests verified the same opening-stock fingerprint before and after the ledger-position schema. The updated Linux x86_64 archive passed checksum and isolated installation checks.

A disposable Compose project on the Bun 1.4.4 base image verified the recovery ingress command with local API, worker and web code. With the worker stopped, Caddy stayed closed. After the worker became healthy, the command reopened the selected Caddy, matched its access log and passed an independent request to `/api/ready`. The command tests covered stale probe evidence, worker failure after opening Caddy, ambiguous Docker start failures and SIGTERM during a blocked log command.

The subsequent local restore-switch rehearsal created a synthetic appointment through the public API, including a staff assignment, a service and a required equipment allocation. The checksummed backup restored into a separate PostgreSQL database. Both copies of the appointment and its allocations matched after restore, after an old-generation cancellation returned HTTP 409, and after switching back to the source database. The restored appointment appeared in the sync replica under the new generation. A separate disposable Compose run rejected both a healthy worker on the source database and the previous Compose environment file, then reopened successfully with the restored environment file. These runs used local code and the Bun base image with external delivery disabled.

## Full Compose rehearsal — 2026-11-19

The disposable production Compose rehearsal passed with email, desktop, migration and restore checks enabled. The native suite passed 20 tests through Caddy, plus the separate email delivery test. The imported partial-payment case verified that the booking shows a balance due until the remaining amount is paid. The rehearsal recovered from the failed maintenance migration, switched to a separate restored database, rejected writes from the previous replica generation and switched back. Temporary authentication and OAuth budgets accommodated the synthetic clients that share a single IP.

A subsequent run passed 21 native tests and the separate email delivery test through Caddy, with migration and restore checks enabled. The linked client opened the unpaid appointment queue, and the weekly-hours test used a date inheriting the weekly template so a prior scenario's date override could not mask its expected conflict. The run restored a separate database, verified the inventory ledger, rejected the old ledger anchor and replica generation, and switched back. API and native regression tests also verified historical billing and attribution for inactive professionals.

The full Compose rehearsal passed again after adding the recurring booking pause checks. An authenticated synthetic customer received `409 online_booking_paused` through Caddy for both a new preview and a pending confirmation with a review hash obtained before the pause. The suite reopened booking before continuing with desktop sync, migration rollback, mail delivery and restore.

The separate Booksy candidate audit verified 1,053 archived originals and reconciled all 27 pending price rows to the native agenda. The cutover flag remains false. [Import protocol](booksy-import-protocol.md)

## Local verification evidence — 2026-11-15

- API: 686 tests; web: 604; contracts: 113; database: 47; scripts/backup/release: 24.
- Playwright: 175 passed, 3 platform-specific skips, including all six screenshot-capture cases.
- Rust: 104 core and 21 GUI tests, plus 4 headless sync tests against the real API.
- Production smoke: passed on the pinned Bun 1.4.4 images, including migration `0008`, authentication, booking conflicts, proxy isolation and container hardening.
- JavaScript audit: zero reported vulnerabilities in both production and full dependency trees. The older Rust advisory review and its upstream warnings remain documented in [security-review.md](security-review.md).
- Formatting, lint, TypeScript checks, production builds and Clippy: passed.
- Optimized Linux x86_64 executable: built successfully (33 MB); its local archive is about 11 MB and the generated SHA-256 checksum verifies.
- A real executable launch under Xvfb could not create the Vulkan surface (`No DRI3 support`, `PlatformNotSupported`). That Xvfb result applied to the test session on 2026-11-15. The later Wayland check is recorded above.
- Two startup-date regressions cover a salon whose day differs from UTC, including initial catalog synchronization and preservation of explicit dates.
- A GPUI regression first reproduced inaccessible late-week columns at 800 px; horizontal scrolling now keeps day headers aligned with the calendar body.

Real SMTP/SMS delivery, production HTTPS and third-party MCP hosts require the corresponding external accounts/environment. Configure and verify those when available; the repository contains the deployment configuration and local adapters/tests.
