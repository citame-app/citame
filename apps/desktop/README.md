# Sisters of Beauty desktop client

Offline-first front-desk client in Rust: a GPUI app over a GUI-free core crate. Decisions and rationale: [ADR 0008](../../docs/adr/0008-desktop-client.md). The protocol it implements: [docs/sync-protocol.md](../../docs/sync-protocol.md).

```text
apps/desktop
  crates/core   sob-core: SQLite store + outbox, sync engine, runner, HTTP/SSE, auth, calendar model, i18n
  crates/app    sob-desktop: GPUI shell (login, day/week calendar, booking, conflicts, sync status, light/dark theme)
  vendor/xattr  one-line patch so gpui compiles on current Linux toolchains (see the ADR)
```

## Build and run

The workspace pins Rust 1.98.1. macOS builds require Xcode with the Metal compiler. The core needs only a C compiler (bundled SQLite). The GPUI crate also needs the Linux graphics stack: Wayland or X11 client libraries, `xkbcommon(-x11)`, `fontconfig`, `freetype`, a Vulkan loader, `openssl` and `zstd` headers, and `cmake`/`pkg-config`. On Debian or Ubuntu (the package list Zed documents; verified here only in the sense that all of these were already installed when the app was built and run):

```bash
sudo apt install build-essential cmake pkg-config libasound2-dev libfontconfig-dev libwayland-dev \
  libxkbcommon-x11-dev libssl-dev libzstd-dev libvulkan1 mesa-vulkan-drivers
```

The running app needs a Linux graphical session with Vulkan presentation support. A plain Xvfb display may lack DRI3: in this session it could not create the GPUI surface. GPUI interaction tests use their deterministic test platform and do not establish real-driver compatibility.

```bash
cd apps/desktop
export CARGO_TARGET_DIR=$PWD/target        # already git-ignored; a debug GUI build is ~2 GB
cargo run -p sob-desktop                    # needs a reachable API to sign in for the first time
```

On the first launch, enter the Citame address used by your centre. A bare hostname opens over HTTPS. For local development, the selector accepts HTTP on loopback. From the calendar, use **Server** to switch between centres. Returning to a previous server restores its saved session and its offline queue. The selected address and theme are saved on this device.

| Variable            | Default                                      | Meaning                                                                                                                                   |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SOB_API_URL`       | `api-url` file, then `http://127.0.0.1:3000` | Set an explicit origin to lock the selector for this launch. The web origin must proxy `/api/auth`, `/sync` and `/me`. |
| `SOB_DATA_DIR`      | Platform data directory                      | Linux uses XDG data, defaulting to `~/.local/share`. macOS uses `~/Library/Application Support`. Both append `sisters-of-beauty/desktop`. |
| `SOB_LANG` / `LANG` | English                                      | `es*` selects neutral es-AR                                                                                                               |
| `SOB_THEME`         | system appearance, then saved choice         | `light`, `dark` or `system`; the header toggle saves its choice to `theme` in the data directory.                                         |
| `SOB_START_DATE`    | today                                        | `YYYY-MM-DD`, open the calendar on that day                                                                                               |
| `SOB_START_VIEW`    | none                                         | QA startup view, for example `reports`, `reports-cancelled`, `reports-no-show`, `reviews`, `new`, `block`, `details` or `conflicts`.   |

Finder and Linux menu launches use the same server selector. Enter the public HTTPS origin where you normally open Citame, such as `https://citame.example`. The HTTP client sends OAuth and sync requests to that origin. Use the final address if the server redirects. Plain HTTP is supported for loopback development. Enable `SOB_STARTUP_TIMINGS=1` to log the elapsed time to GPUI's first frame callback.

Session files are scoped to the API origin. SQLite mirrors, pending changes and conflicts are scoped to the origin, user and role. Switching accounts stops the old sync worker and preserves its queue for when that account returns. Earlier unscoped `replica.db` and `session.json` files are left in place. First sign-in after upgrading starts a new scoped replica. Any pending changes from the old client need to be synchronized with that client or recovered before retiring it, since the earlier files do not identify which account owns each write.

Select **Sign in in your browser** and enter your owner or staff email and password on the selected server. Approve Citame Desktop, then return to the app. OAuth authorization code flow uses PKCE S256 and a loopback callback. The device stays linked and uses its private key to renew short-lived sync tokens automatically. Each origin has its own private credential file. Open **My account → Profile → Desktop devices** in the web app to see linked devices and disconnect one. **Sign out** in the desktop app disconnects that device when it can reach the server. Pending edits stay in the local database for the same account, role and server. Sign in again once after upgrading from a cookie or rotating-refresh-token session to register the device.

For an interactive browser test against an isolated stack, run
`SOB_TEST_API_URL=http://localhost:8088 cargo test -p sob-core --test browser_oauth -- --ignored --nocapture`
from `apps/desktop`. Open the printed URL and sign in as the synthetic owner.

**Open web calendar** opens the configured centre with the same owner or staff account used in the app. It preserves the date, calendar view and selected professional. The handoff needs a network connection and uses a single-use ticket that expires after one minute. An unverified handoff stays in the desktop app and shows an error.
The test reloads the saved device credential, forces token renewal, and verifies that a synthetic contact queued in SQLite survives closing and reopening the replica. It then verifies that the contact arrives in an independent replica and that a contact queued there returns to the first replica. Finally it disconnects the device and verifies that its credential can no longer renew.

Using it: Day view shows one column per staff member; Week view shows Monday to Sunday for the selected member. The header switches views and moves by one day or one week. Text inputs support selection, clipboard shortcuts, grapheme-aware editing and IME composition. In the calendar, "New appointment" books (a new client can be typed in), clicking a booking opens move (time and staff) and cancel, or completed/no-show for a booked appointment that has started. Closed appointments cannot be moved or cancelled. Edits apply locally at once and show a "Pending sync" badge until the server acknowledges them. The header shows online or offline, the last sync (or the retry countdown), the number of pending edits and, when the server refused something (for example the slot was taken meanwhile), a "to review" badge: the conflicts dialog offers another time, dropping the booking or cancelling the appointment, or dismissing the notice.

Drag across free time in a calendar column to show the selected hours next to the pointer. Release to choose a new appointment or a block with the selected professional and time. The service and cleanup must fit in the selected booking range. Appointment cards use the first service color from the catalogue when available.

Manual booking rejects skipped or repeated local start times before queuing the appointment or a new contact. Moving a booking or retrying a conflict by one calendar day keeps the local hour. Existing bookings in a repeated hour show the corresponding UTC offset in their details.

**Team shifts** opens a weekly view from the SQLite replica, including dated overrides, closed days and absences. Dates and professional names stay visible when scrolling the grid. Enter a date in `YYYY-MM-DD` format and press Enter or **Go to week** to open the week that contains it. The roster follows the last synced permissions. Pending local blocks are marked and the view updates when new changes reach the replica. Selecting a professional opens their native calendar for the selected week. With a connection, an owner or manager can use **Edit shift** to review and change one date. Use **Copy…** on the professional’s row to copy up to seven consecutive dates to one or more target weeks. Review the current and proposed schedules for every target before applying. Choose **Hours** on the same row to edit the weekly template with an active connection. The editor preserves a stale draft until you discard it and reload the schedule. Open an affected appointment from either conflict list and return to the same scheduling draft.

"Block time" creates a timed or all-day block in the salon timezone. Open a block in the calendar or from "Blocks" to edit it or confirm its removal. Booked visits remain visible. Offline changes enter the durable queue, and an edit or removal based on an older server version appears in the conflicts dialog. The desktop uses the last synced calendar permissions offline. The server enforces the current access preset when syncing.

Booking and moving a visit checks the local blocks and the professional's last synced capacity before queuing the edit. The check includes outstanding local edits, frozen work windows and previously imported bookings. A conflict retry keeps the selected time if that slot is already occupied locally. Server-side validation still checks current capacity and physical resources at sync. Simultaneous visits have separate cards within their calendar column.

The desktop shows a toast for a new reservation received through sync after the initial snapshot. It shows the client, services, professional and local time. Opening it jumps to the appointment. Initial snapshots, Booksy groups and bookings confirmed from this same replica do not trigger toasts.

Appointment details fetch private notes from the authorized endpoint and refresh them when a newer appointment revision reaches the open detail. The SQLite replica carries the indicators. **Edit service details** sets or clears a professional preference and edits the internal note for that service. Saving requires a connection and the versions the operator reviewed. Changing just the note preserves the original preference, including after reassignment. If someone else saves first, the editor keeps the draft for review.

The **Notifications** button opens the shared calendar inbox for new, moved and cancelled appointments. The list refreshes when the sync cursor advances and when the desktop reconnects. Archiving and restoring a notice update the same per-user inbox as the web app and require a connection. The first page of each tab is saved in the private local replica for offline consultation.

**Clients** searches the local directory by name, phone or email. Reception can add contacts, edit names, phone numbers and notes, and open recent appointments saved on the device. Contact edits work offline and enter the same sync queue as calendar edits. Citame rejects an edit if another device has changed the contact since it was opened. Reopen the current contact before preparing a new edit. When directory or calendar permissions change, the next device sync reloads the visible replica and preserves the pending queue. Photos, customer forms and merging contacts are available in the web desk.

The **Waitlist** button opens the active queue, all requests and the Booksy requests awaiting review. The first active page is cached for offline consultation. Creating or cancelling a request requires a connection and uses the permissions and policy of the web API. Review of an imported request preserves its date and client. Past requests remain visible without a completion action. For a current request, pause automatic offers and confirm the professional preference explicitly, including any qualified professional. The selected services and their cleanup time must match the imported duration. With a connection, staff can review the slot, frozen price and expiry, accept or requeue an offer and open the resulting appointment. Owners can pause the queue or change the offer duration. Staff can explicitly choose eligible saved responses for intake requirements. New required form responses are entered in the web desk.

Choose **Open appointment receipt** from an eligible EUR appointment to open the same receipt as the web desk. The receipt shows the server-calculated discount, the current balance and the amount collectible now. A reconciled Booksy part-payment also shows the amount already paid in Booksy. Register the amount received in cash or on the card terminal, including split payments. Cash needs an open register. The desktop submits the payment online and reuses the request key when confirming the same attempt again after an interrupted response.

**Cash register** opens the shared till for accounts with cash management permission. Enter the opening float, record cash deposits or withdrawals with a reason, or reconcile the counted cash at closing. Citame displays the expected amount, the difference and the most recent movements. Register operations need a connection. If another operator changes the expected amount before closing, reload the register and review the count again.

**Reports** opens the shared operational report. The period uses the centre's local dates. Accounts with access to all calendars can filter by team member, and the server limits other authorized accounts to their own appointments. The table groups results by day, start hour, service, category, add-on or team member. Save CSV exports the report shown in the panel. An open report updates as sync advances and when the device reconnects. While offline, the application can display the last result fetched in that panel.

The **Cancellations** and **No-shows** views show the matching appointments using the same period, team member and currency. Their respective CSV buttons download every matching row for the selected outcome. The detailed exports require a connection, and the desktop only creates the destination file after the download completes.

Owners and managers can open **Reports → Clients**. The period and team member filters include historical activity from inactive professionals. Each client counts once across merged profiles. Returning clients had a completed visit at the centre before the selected period, according to the history available in Citame. The CSV includes every daily row in the filtered result.

**Request reviews** lets owners and managers search elapsed visits by client, copy a private link and queue a review email after confirming the visit. It uses the same live status and one-invitation-per-visit rule as the web desk. The send option requires a verified address, commercial email permission and a configured worker. Review links are held in the open panel and are excluded from the offline replica.

**Reputation → Moderate reviews** shows the shared list and publication status. Owners and managers can publish, hide with a reason, write a public reply or remove one. Review changes need a connection. The desktop keeps the reviewed version and its draft after an unsuccessful save, and asks before discarding changes.

### Inventory

**Inventory** searches products by name, SKU or barcode and can include archived products. The detail shows the latest stock and the optional amount and unit of content per pack. Owners and managers can change or clear the pack content without recording a stock movement. Open **Stock history** to see the shared ledger and record deliveries, consumption and physical counts. A count replaces the physical total and respects the units reserved for sales. Catalog and idle stock views refresh through sync when connected.

Open **Stock movements** to see the history across products. Search by name, SKU or reason, or choose a movement type. Opening a product keeps the filter and page when you return. New movements are announced while you browse. Choose **Show latest movements** to include them and return to page one. **Save CSV** exports the matching rows from the current view using your inventory permissions. This view requires a server connection.

If a connection drops with a product already open, you can save one movement per product on this device. Open the product and choose **Retry the same movement** when connected. Citame keeps the exact request in SQLite through app restarts and uses its original version and key. A version conflict requires reviewing current stock. After a database restore, Citame asks you to review the current stock and history before discarding a rejected request from the previous generation. The full catalog and movement history load from the server.

## Prepare a Linux release locally

```sh
# From the repository root; no registry, remote or production domain is needed.
bun run release:check
(cd apps/desktop && cargo build --release --locked -p sob-desktop)
bash scripts/package-desktop.sh
(cd .release/desktop && sha256sum -c *.sha256)
```

The archive includes the executable, installer, application icon, MIT license, this guide and release metadata (source revision and whether the checkout was dirty). Packaging on the target architecture generates a deterministic archive and SHA-256 checksum.

The Linux release job installs the archive in a temporary user directory. It validates the launcher and native x86-64 executable, checks the linked libraries and opens a temporary SQLite replica. The version reported by the installed executable must match the release tag.

After checking the checksum, extract the archive and run its `./install.sh` as your own user. The installer adds **Citame** to the applications menu and puts the executable in `${XDG_DATA_HOME:-$HOME/.local/share}/citame/bin`. The application settings and offline replica stay in the separate data directory shown above. Reinstalling updates only the executable, icon and launcher. See [release.md](../../docs/release.md) for the release gates.

## Build for macOS

Run on each target architecture with Xcode available. The GitHub release workflow defines native builds on Intel and Apple Silicon, including a package and checksum for each.

```sh
(cd apps/desktop && MACOSX_DEPLOYMENT_TARGET=15.0 cargo build --release --locked -p sob-desktop)
bash scripts/package-desktop-macos.sh
(cd .release/desktop && shasum -a 256 -c ./*.zip.sha256)
```

The ZIP contains `Citame.app` targeting macOS 15 and later. Packaging reopens the ZIP and verifies the bundle, Mach-O architecture and minimum OS, signature, and SQLite startup. The **macOS desktop verification** workflow runs these checks on Intel and Apple Silicon and produces ad hoc signed test packages. The release workflow requires Developer ID signatures and checks the stapled notarization ticket in the extracted bundle.

On the target Mac, use the following command to verify that the archived app opens a GPUI window with a temporary profile and measure its time to the first frame. Use `CITAME_MAC_REQUIRE_NOTARY=1` as well when checking a release artifact.

```sh
CITAME_MAC_VERIFY_GUI=1 bash scripts/verify-desktop-macos.sh path/to/Citame.zip
```

The arm64 build targets Apple Silicon, including M3. The standard GitHub arm64 runner uses M1. Testing window rendering on M3 requires access to an M3 Mac. [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Functional scope

This client covers the appointment desk, notifications, waitlist requests, appointment receipts, cash register management, the online unpaid appointments and billing review queue, inventory browsing, pack content, per-product stock operations, the global stock ledger and CSV, operational and client reports, sync conflict review, team portraits, schedule templates and dated shifts. Client selection and basic contact management work locally. Advanced client management, team account administration, service catalog, walk-in sales, hosted and prepaid tenders, inventory catalog administration, marketing, financial reports, commissions and business settings are available in the web app. The private Booksy consultation environment provides read-only access to the imported calendar.

### Pruebas locales con el calendario importado

En el equipo donde se preparó la copia, abre **Citame (pruebas locales)** desde el menú de aplicaciones o ejecuta `~/.local/bin/citame-pruebas-locales`. El lanzador solicita el arranque de los servicios de usuario en segundo plano y abre la app de escritorio. Si la API no está disponible, puedes consultar la última réplica sincronizada. La app y la [agenda web](http://127.0.0.1:4275/admin/calendar) usan la misma copia editable en `http://127.0.0.1:4275`. Si necesitas vincular el equipo otra vez, elige **Iniciar sesión en el navegador** y aprueba el acceso de escritorio con la cuenta indicada en el archivo privado `~/.local/share/citame/local-desktop-test/local-owner.json`.

La réplica y las credenciales quedan en el subdirectorio `profile`. La copia editable conserva los originales en el esquema de importación y se ejecuta sin cobros reales, workers de notificaciones ni pruebas de envío por correo. La API operativa rechaza esta base. Para apagar la web y la API local usa `systemctl --user stop citame-local-web.service citame-local-api.service`. La app puede seguir consultando la réplica guardada y reanuda la sincronización al volver a iniciar los servicios.


## Tests

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace            # core unit tests + GPUI interaction tests (needs the graphics libs)
cargo test -p sob-core            # core only: no graphics libraries needed
```

The headless sync tests talk to the REAL API, Postgres and Valkey and are ignored by default. With a dedicated database:

```bash
docker compose up -d --wait postgres valkey
docker compose exec postgres psql -U sob -d postgres -c 'create database sob_test_desktop'
export DATABASE_URL=postgres://sob:sob@localhost:5432/sob_test_desktop
bun run db:migrate && bun run db:seed
BETTER_AUTH_SECRET=$(openssl rand -base64 32) OWNER_EMAIL=owner@desktop.test OWNER_PASSWORD=change-me-please bun run bootstrap:owner
# API on :3055 with its own Valkey key prefix and relaxed rate limits
BETTER_AUTH_SECRET=... BETTER_AUTH_URL=http://127.0.0.1:3055 PORT=3055 VALKEY_KEY_PREFIX=sobdesk: \
  RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_GLOBAL_MAX=100000 bun apps/api/src/index.ts &
SOB_TEST_API_URL=http://127.0.0.1:3055 SOB_TEST_EMAIL=owner@desktop.test SOB_TEST_PASSWORD=change-me-please \
  cargo test -p sob-core --test headless_sync -- --ignored --test-threads=1 --skip through_the_proxy
```

Run `SMOKE_EMAIL=1 SMOKE_DESKTOP=1 bash scripts/smoke-prod.sh` from the repository root to exercise review invitations and moderation through the production proxy. These tests drive the sign-in and consent HTTP endpoints with a synthetic owner. The Rust client receives the loopback callback, links the device, reopens the saved session with an expired access token, renews it, and verifies revocation.

With `SMOKE_DESKTOP=1`, the script also seeds a synthetic imported waitlist request in the disposable stack. The linked device and a web session verify that offers must be paused, the operator must confirm the staff preference, and replay after re-enabling offers preserves the same entry.

`cargo run -p sob-core --example demo_replica -- <data-dir> <api-url> <email> <password>` prepares a data dir with a saved session and a replica holding a synced booking, a lost-slot conflict and a pending offline booking, to look at the GUI in those states (`SOB_DATA_DIR=<data-dir> SOB_START_DATE=<printed day> cargo run -p sob-desktop`).
