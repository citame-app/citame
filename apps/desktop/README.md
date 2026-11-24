# Sisters of Beauty desktop client

Offline-first front-desk client in Rust: a GPUI app over a GUI-free core crate. Decisions and rationale: [ADR 0008](../../docs/adr/0008-desktop-client.md). The protocol it implements: [docs/sync-protocol.md](../../docs/sync-protocol.md).

```text
apps/desktop
  crates/core   sob-core: SQLite store + outbox, sync engine, runner, HTTP/SSE, auth, calendar model, i18n
  crates/app    sob-desktop: GPUI shell (login, day/week/month/list calendar, booking, conflicts, sync status, light/dark theme)
  vendor/xattr  one-line patch so gpui compiles on current Linux toolchains (see the ADR)
```

## Build and run

The workspace pins Rust 1.98.1. macOS builds require Xcode with the Metal compiler. The core needs only a C compiler (bundled SQLite). The GPUI crate also needs the Linux graphics stack: Wayland or X11 client libraries, `xkbcommon(-x11)`, `fontconfig`, `freetype`, a Vulkan loader, `openssl` and `zstd` headers, and `cmake`/`pkg-config`. On Debian or Ubuntu (the package list Zed documents; verified here only in the sense that all of these were already installed when the app was built and run):

```bash
sudo apt install build-essential cmake pkg-config libasound2-dev libfontconfig-dev libwayland-dev \
  libxkbcommon-x11-dev libssl-dev libzstd-dev libvulkan1 mesa-vulkan-drivers
```

The running app needs a Linux graphical session with Vulkan presentation support. In a GNOME Wayland session, Citame requests the native title bar through XWayland when the local X display connects and offers DRI3. If XWayland cannot initialize, Citame retries once on Wayland and draws a title bar with close and the window controls supported by the compositor. The title bar is hidden in fullscreen. A plain Xvfb display can lack the DRI3 extension required for Vulkan presentation. GPUI interaction tests use their deterministic test platform and do not establish real-driver compatibility.

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
| `SOB_START_VIEW`    | none                                         | QA startup view, for example `team-week`, `month`, `list`, `reports`, `reports-cancelled`, `reports-no-show`, `reviews`, `new`, `block`, `details` or `conflicts`.   |

Finder and Linux menu launches use the same server selector. Enter the public HTTPS origin where you normally open Citame, such as `https://citame.example`. The HTTP client sends OAuth and sync requests to that origin. Use the final address if the server redirects. Plain HTTP is supported for loopback development. Enable `SOB_STARTUP_TIMINGS=1` to log the elapsed time to GPUI's first frame callback.

An owner can open **Management → Business and booking settings** to edit the salon name and time zone, public booking availability, notice, horizon and slot spacing, and both reminder intervals. After the first sync that loads these settings, the locally saved copy is available offline. **Save for next sync** puts the edit in the same durable queue as appointment changes. The edit survives closing Desktop and goes to Cloud automatically when the connection returns. When Cloud changed after the owner reviewed the settings, **Sync conflicts → Business and booking settings** can load the latest version with the proposed fields preserved for review. The public booking policy changes once Cloud accepts the edit.

**Management → Booking protection** edits the same versioned deposit, cancellation and no-show terms as Cloud. Opening or publishing this policy requires a connection. The form keeps an open draft if Cloud changes and lets the owner review those edits against the current policy before submitting. Existing bookings retain the terms they originally accepted.

**Management → Service assignments** opens the synced catalogue and the professionals assigned to each service. Owners can save and revise assignments while offline. The booking calendar uses the queued changes for new appointments, and Cloud validates each request in order during sync. If the team changed while a device was offline, **Sync conflicts → Review assignment** keeps the proposed edits available to review against the latest team. See [ADR 0023](../../docs/adr/0023-reviewed-offline-service-assignments.md).

**Management → Staff access** lets the owner review the current access profile and choose Manager, Reception, Professional or Restricted. **Create staff account** adds a login and a bookable calendar with an optional public display name. Choose an email invitation or set an initial password. Creation is online and tied to the current database. After a database restore, review the current centre before resubmitting the draft. For a linked account, the owner can review and confirm a change between Owner, Staff and Client. The account role is separate from a staff access preset. From Management, **Find an account without a calendar** reviews an existing login by exact email. Granting a staff role creates its calendar and retains any client profile. Staff or owner access requires a verified email address. Switching to Client deactivates the calendar and requires all upcoming appointments to be reassigned or resolved first. Select **Link login to this calendar** for an unlinked profile to queue an email invitation or assign an initial password. Publishing requires a connection. The server checks the linked account, the reviewed version and the replica generation. If another session changes the profile or the linked account while the panel is open, the current profile updates and a pending choice stays available for review.

**Management → Service catalogue** lets owners and managers update service details and assigned professionals in one offline edit once the catalogue revisions have synced. Cloud commits the full edit in one transaction. Submitted edits survive a restart and can be reviewed in **Sync conflicts** when Cloud has a newer version. Review reapplies additions and removals to the current team, so assignments changed by another operator remain visible. The reviewed version and centre generation must still match when the server applies the change. A pending change to service terms or assignments pauses new bookings for that service until it is confirmed or a conflict is reported. Existing bookings keep their recorded prices and durations.

The same editor updates variant labels and add-on eligibility. Open a pending service in the catalogue to review the queued proposal. Variant labels changed on both devices require a choice during conflict review. Eligible services added or removed in the draft are reapplied to the current Cloud set, and Cloud validates their availability and currency in the same transaction.

**Management → Service resources** configures which rooms, stations or equipment a service requires, their quantities, and whether to require all selected resources or one alternative. Open a service online once to cache its reviewed settings and the resource pools. Later edits can be queued offline. Review a rejected draft against Cloud from **Sync conflicts**.

**Management → Rooms and equipment** creates, edits, deactivates and reactivates resource pools. After the catalogue has synced, edits can be queued offline. Confirmed changes use the same validation and future-allocation safeguards as Cloud. A newly created resource becomes available for assignment after Cloud confirms it.

**Management → Treatment combinations** creates and edits ordered treatments and add-ons, multiline descriptions and online availability. Once the catalogue has synced, drafts can be saved offline and amended before submission. Review a rejected draft from **Sync conflicts**. Confirmation uses the same service and staff eligibility rules as Cloud.

For fixed-price combinations, set the EUR amount for each treatment and choose the eligible professionals and booking visibility. Moving a treatment keeps its amount attached. A restored or concurrent edit reviews the treatment order and fixed terms together. Archive a staff-only combination before switching it to catalogue pricing. The first sync after upgrading refreshes the catalogue before enabling offline combination management.

In **Calendar → New appointment**, choose a fixed-price combination to review its treatments and amounts and pick an eligible professional. Use **Show available times** to check the selected day when connected. Offline, select the start on the saved calendar. The server checks the terms on reconnection and sends stale or overlapping bookings to **Sync conflicts**. Existing bookings keep their original prices and eligible staff when rescheduling, including after the offer is archived.

**Management → Inventory** filters products by name or reference, category, brand, sale availability, catalogue status and low stock. Choose the order and page size in **Filters and sort**. **Export CSV** downloads every matching product in that order. The summary covers the filtered catalogue. Cost totals and product costs appear only when the account has cost access.

Inventory editors can create products and change their details, prices before or after VAT, pack content, targets and catalogue status. A product opened for review is available from the saved product details list when offline. After the device has verified inventory access, Save queues those changes even if the connection drops. Pending changes survive restarts and Sync conflicts can compare a rejected proposal with current Cloud values. An opening quantity creates one stock movement. Edit subsequent stock through the movement controls.

Use **New service** to add a standalone treatment, variant or add-on with its professional assignments. Authorized staff can queue all three types from their previously synced catalogue while offline. After a database restore, load the current catalogue and explicitly review the recovered draft before requeueing it. Submitted entries survive a restart, appear as pending, and become bookable after Cloud accepts them. A rejected entry can be corrected from **Sync conflicts** without creating a second service.

Desktop opens one application process per local data directory. Open the existing window for that profile, or use a separate `SOB_DATA_DIR` for a separate profile. The operating system releases the lock when Citame exits. Close older versions of Desktop before updating.

Session files are scoped to the API origin. SQLite mirrors, pending changes and conflicts are scoped to the origin, user and role. Switching accounts stops the old sync worker and preserves its queue for when that account returns. Earlier unscoped `replica.db` and `session.json` files are left in place. First sign-in after upgrading starts a new scoped replica. Any pending changes from the old client need to be synchronized with that client or recovered before retiring it, since the earlier files do not identify which account owns each write.

Select **Sign in in your browser** and enter your owner or staff email and password on the selected server. Approve Citame Desktop, then return to the app. OAuth authorization code flow uses PKCE S256 and a loopback callback. The device stays linked and uses its private key to renew short-lived sync tokens automatically. Each origin has its own private credential file. Open **My account → Profile → Desktop devices** in the web app to see linked devices and disconnect one. **Sign out** in the desktop app disconnects that device when it can reach the server. Pending edits stay in the local database for the same account, role and server. Sign in again once after upgrading from a cookie or rotating-refresh-token session to register the device.

For an interactive browser test against an isolated stack, run
`SOB_TEST_API_URL=http://localhost:8088 cargo test -p sob-core --test browser_oauth -- --ignored --nocapture`
from `apps/desktop`. Open the printed URL and sign in as the synthetic owner.

**Open web calendar** opens the configured centre with the same owner or staff account used in the app. It preserves the date, calendar view and selected professional. The handoff needs a network connection and uses a single-use ticket that expires after one minute. An unverified handoff stays in the desktop app and shows an error.
The test reloads the saved device credential, forces token renewal, and verifies that a synthetic contact queued in SQLite survives closing and reopening the replica. It then verifies that the contact arrives in an independent replica and that a contact queued there returns to the first replica. Finally it disconnects the device and verifies that its credential can no longer renew.

Using it: Day view shows one column per staff member; Week view shows Monday to Sunday. The individual timeline supports the time grid and drag-to-book or block. **Team week** shows the visible professionals side by side with their appointments, absences and days without working hours. Select a professional to open their individual weekly timeline, or select an appointment count to open that professional’s day grid. Owners can limit the weekly roster to professionals with working hours during the week. Click the date in the header to choose a date in the calendar or enter it as `YYYY-MM-DD`. Month view shows complete Monday-first weeks, appointment counts and quick links to the day or individual appointments. List view starts on the selected date and groups seven days of appointments chronologically with the professional and scheduled value. Month and List can filter by professional, client, service and appointment status. Both views use the local replica while offline, and the cancellation toggle includes cancelled appointments when selected. The header moves by one day, one week or one month according to the active view. Week starts on Monday and keeps the selected day for new bookings, Cloud handoff and switching back to Day. Text inputs support selection, clipboard shortcuts, grapheme-aware editing and IME composition. In the calendar, "New appointment" books (a new client can be typed in), clicking a booking opens move (time and staff) and cancel, or completed/no-show for a booked appointment that has started. Closed appointments cannot be moved or cancelled. People who can edit all calendars can correct completed appointments and no-shows from the appointment details. Edits apply locally at once and show a "Pending sync" badge until the server acknowledges them. The header shows online or offline, the last sync (or the retry countdown), the number of pending edits and, when the server refused something (for example the slot was taken meanwhile), a "to review" badge: the conflicts dialog offers another time, dropping the booking or cancelling the appointment, or dismissing the notice.

Appointment details load the deposit state from Cloud alongside the private appointment context. The panel shows applicable payment and free cancellation deadlines. Accounts with commerce access also see the deposit, fee retained and refund due. Open details can refresh the panel, and an already loaded state can remain visible if the connection drops. Reopening an appointment offline does not fetch its payment context.

Open **Keyboard shortcuts** from the calendar header or press `?`. Use `T` for today, the left and right arrows for the previous and next period, `D`, `W`, `M` and `L` to switch views, `N` to open a new appointment, and `R` to sync. In the day or individual week timeline, use Tab to focus an appointment. Use Alt+Up or Alt+Down to move it by one slot. In Day view, use Alt+Left or Alt+Right to change to the adjacent visible professional. Use Page Up and Page Down to scroll the timeline, or hold Shift to scroll across columns. Shortcuts are paused while a dialog is open or while selecting a time range.

Drag across free time in a calendar column to show the selected hours next to the pointer. Release to choose a new appointment or a block with the selected professional and time. The service and cleanup must fit in the selected booking range. Appointment cards use the first service color from the catalogue when available.

Manual booking rejects skipped or repeated local start times before queuing the appointment or a new contact. Moving a booking or retrying a conflict by one calendar day keeps the local hour. Existing bookings in a repeated hour show the corresponding UTC offset in their details.

**Team shifts** opens a weekly view from the SQLite replica, including dated overrides, closed days and absences. Dates and professional names stay visible when scrolling the grid. Enter a date in `YYYY-MM-DD` format and press Enter or **Go to week** to open the week that contains it. The roster follows the last synced permissions. Pending local blocks are marked and the view updates when new changes reach the replica. Selecting a professional opens their native calendar for the selected week. With a connection, an owner or manager can use **Edit shift** to review and change one date. Use **Copy…** on the professional’s row to copy up to seven consecutive dates to one or more target weeks. Review the current and proposed schedules for every target before applying. Choose **Hours** on the same row to edit the weekly template with an active connection. The editor preserves a stale draft until you discard it and reload the schedule. Open an affected appointment from either conflict list and return to the same scheduling draft.

"Block time" creates a timed or all-day block in the salon timezone. Open a block in the calendar or from "Blocks" to edit it or confirm its removal. Booked visits remain visible. Offline changes enter the durable queue, and an edit or removal based on an older server version appears in the conflicts dialog. The desktop uses the last synced calendar permissions offline. The server enforces the current access preset when syncing.

Booking and moving a visit checks the local blocks and the professional's last synced capacity before queuing the edit. The check includes outstanding local edits, frozen work windows and previously imported bookings. A conflict retry keeps the selected time if that slot is already occupied locally. Server-side validation still checks current capacity and physical resources at sync. Simultaneous visits have separate cards within their calendar column.

Opening an appointment from a grouped visit shows the other appointments in that visit available to the signed-in account. The cards show their date, professional, services and status. Open a card to review that appointment. This uses the local calendar replica and works offline. Finish editing the current appointment before switching to another.

To book a visit with more than one professional, choose an existing client, select the first professional and services, then choose **Add this step and choose the next**. Add up to eight steps in order. Review the forms for each step, check the times and prices, and confirm the full visit. Citame rechecks professional and resource availability and commits all steps together. A connection is required for review and confirmation. Retry from the open review if the response is interrupted.

In **New appointment**, use **Repeat** for a weekly or monthly series of up to 12 visits. Select the interval and total number of visits, including the first. The review shows the salon's local dates, times, price per visit and availability. Confirm all visits together once every date is available. If a date becomes occupied, the server rejects the whole series and the desktop can refresh the review. The current catalogue and booking forms apply to every visit. The same short-notice rules as Cloud apply. An authorized manager can record a deposit waiver for the whole series. A connection is required to review and commit a series. If the response is interrupted, retry from the open review to recover the original series.

The desktop shows a toast for a new reservation received through sync after the initial snapshot. It shows the client, services, professional and local time. Opening it jumps to the appointment. Initial snapshots, Booksy groups and bookings confirmed from this same replica do not trigger toasts.

Appointment details fetch private notes from the authorized endpoint and refresh them when a newer appointment revision reaches the open detail. The SQLite replica carries the indicators. **Edit service details** sets or clears a professional preference and edits the internal note for that service. Saving requires a connection and the versions the operator reviewed. Changing just the note preserves the original preference, including after reassignment. If someone else saves first, the editor keeps the draft for review.

Desktop shows a live notice for appointments created, moved or cancelled elsewhere after the initial sync. A professional also sees appointments moved into their restricted calendar. The notice stays available while a dialog is open, and **View appointment** opens the relevant day and details after that dialog is closed. Versions acknowledged from this device do not echo back as notices. The **Notifications** button opens the shared calendar inbox for all three event types. The list refreshes when the sync cursor advances and when the desktop reconnects. Archiving and restoring a notice update the same per-user inbox as the web app and require a connection. The first page of each tab is saved in the private local replica for offline consultation.

**Clients** searches the local directory by name, phone or email. Reception can add contacts, edit names, phone numbers and notes, and open recent appointments saved on the device. Contact edits work offline and enter the same sync queue as calendar edits. Citame rejects an edit if another device has changed the contact since it was opened. Reopen the current contact before preparing a new edit. When directory or calendar permissions change, the next device sync reloads the visible replica and preserves the pending queue. With a connection, the client detail also manages tags and booking access according to the current account's permissions. [Client controls](../../docs/client-controls.md)

The **Waitlist** button opens the active queue, all requests and the Booksy requests awaiting review. Each tab keeps page 1, once loaded, and up to seven other recently loaded pages in the local profile. Offline, the arrows move between saved pages. Saved pages may be older than Cloud. Changes to the profile's calendar or directory access clear them. Creating or cancelling a request requires a connection and uses the permissions and policy of the web API. Review of an imported request preserves its date and client. Past requests remain visible without a completion action. For a current request, pause automatic offers and confirm the professional preference explicitly, including any qualified professional. The selected services and their cleanup time must match the imported duration. With a connection, staff can review the slot, frozen price and expiry, accept or requeue an offer and open the resulting appointment. Owners can pause the queue or change the offer duration. Staff can explicitly choose eligible saved responses for intake requirements. New required form responses are entered in the web desk.

Choose **Open appointment receipt** from an eligible EUR appointment to open the same receipt as the web desk. The receipt shows the server-calculated discount, the current balance and the amount collectible now. A reconciled Booksy part-payment also shows the amount already paid in Booksy. Register the amount received in cash or on the card terminal, or redeem an eligible gift card using its code. Combine these methods to collect a remaining balance. For a customer with an eligible prepaid plan, choose the plan and service to redeem one visit on the receipt. Refunding that tender restores the full visit to the plan. Cash needs an open register. The desktop submits the payment online and reuses the request key when confirming the same attempt again after an interrupted response.

When Redsys is configured, choose online card or Bizum and review the amount on the receipt. **Prepare bank payment** creates one pending bank order and opens that exact order in the linked browser session. The browser can reopen a pending order after a reload. Citame updates the shared receipt when the bank confirms the payment.

Open **Cash register → Gift cards** with a connection to save the complete register visible to
your account. Desktop shows the date of the saved copy and allows local searches and filters when
offline. It also retains up to 64 recently opened movement pages. Codes are revealed and balances
are changed using the online register. Signing out or losing access clears the offline copy.

**Cash register** opens the shared till for accounts with cash management permission. Enter the opening float, record cash deposits or withdrawals with a reason, or reconcile the counted cash at closing. Citame displays the expected amount, the difference and the most recent movements. Register operations need a connection. If another operator changes the expected amount before closing, reload the register and review the count again.

**Reports** opens the shared operational report. The period uses the centre's local dates. Accounts with access to all calendars can filter by team member, and the server limits other authorized accounts to their own appointments. The table groups results by day, start hour, service, category, add-on or team member. Save CSV exports the report shown in the panel. An open report updates as sync advances and when the device reconnects. While offline, the application can display the last result fetched in that panel.

In **Team photos**, load the team member while connected. You can choose a replacement image while that panel stays open offline. The selected file stays attached to that team member until the server confirms the save or you discard it. If the application cannot confirm a change, review the current photo before using its version to save again. Saving and publishing require a connection and separate actions. Desktop keeps one selected image in the local profile. Closing the panel keeps a saved selection. Open Team photos again after restarting, then load and review the current photo for the same member before saving. Only one window can send the saved selection at a time. When Cloud confirms the upload, Desktop records that confirmation before reloading the directory. A confirmed local copy can only be discarded.

The **Cancellations** and **No-shows** views show the matching appointments using the same period, team member and currency. Their respective CSV buttons download every matching row for the selected outcome. The detailed exports require a connection, and the desktop only creates the destination file after the download completes.

Owners and managers can open **Reports → Clients**. The period and team member filters include historical activity from inactive professionals. Each client counts once across merged profiles. Returning clients had a completed visit at the centre before the selected period, according to the history available in Citame. The CSV includes every daily row in the filtered result.

**Request reviews** lets owners and managers search elapsed visits by client, copy a private link and queue a review email after confirming the visit. It uses the same live status and one-invitation-per-visit rule as the web desk. The send option requires a verified address, commercial email permission and a configured worker. Review links are held in the open panel and are excluded from the offline replica.

**Management → Marketing** opens campaign search, status and delivery history. Start with a template, duplicate a campaign as a new draft, or edit an existing draft. Choose an email or SMS message, an automation trigger and audience filters. The message preview uses sample values for the template variables. Saving a draft keeps it private until a separate delivery or activation confirmation. Open a draft to review the eligible audience, configured channels and delivery time. Schedule a campaign in the centre's time zone or leave the date blank to request delivery as soon as possible. Scheduled and active campaigns can be cancelled after confirmation. The native desk requires a connection and retains the exact request for retry if the result is uncertain. Use **Open Marketing in Cloud** to access the other marketing tools.

Under **Management → Marketing → Booking links**, choose public services, compatible extras and an optional professional. Copy the reservation link or the website widget code, open either preview in a browser, share on WhatsApp or Facebook, and save the locally generated QR as a PNG. The generator loads the public catalogue from the connected Citame server. Public links contain only the selected catalogue IDs.

Under **Management → Marketing → Promotions**, search and edit discount codes, change eligibility and usage limits, and set booking windows in the centre's time zone. Promotion saves require a connection and a reviewed version. The editor retains the exact request if Cloud cannot confirm a save. The promotion list refreshes on live updates while preserving the open draft.

**Management → Loyalty** opens the selected client's available, held, expiring and owed points and paginated movement history. Authorized operators can review an exact signed adjustment with a reason before submitting it. A lost response retains the same adjustment request while the operator stays signed in. Reopen the client statement to retry it or acknowledge the checked history. The request stays in memory. A receipt linked to a movement opens in Cloud under the linked operator's session. Statements require a connection.

The owner can review and save the points programme from the same workspace. The server checks the reviewed version and replica generation. Connected Cloud and Desktop views refresh through the existing event stream with no customer or policy data in the event payload. An open draft keeps its reviewed values if another session changes the programme and must be reloaded before saving.

The native receipt offers **Points or promotion** before the first payment. Review the server-priced discount and new total, including booking conditions for timed promotions, then apply it. An unconfirmed write keeps the same reviewed request and prevents taking a payment until it is resolved. Authorized operators can return points on eligible settled receipts after any captured money has been returned. These operations require a connection.

**Reputation → Moderate reviews** shows the shared list and publication status. Owners and managers can publish, hide with a reason, write a public reply or remove one. Review changes need a connection. The desktop keeps the reviewed version and its draft after an unsuccessful save, and asks before discarding changes.

**WhatsApp** in **Management areas** shows the connected Business number, expiry, saved automations and the 20 latest deliveries. Cloud changes update the panel while connected. Edit event automations by selecting an approved template and assigning all of its variables. Pending drafts keep their reviewed revision and are held for review when another session changes the saved rules. Disconnect from Citame here after confirming the specific number. Already dispatched messages and delivery history remain available. Open WhatsApp settings in Web to connect or renew Meta authorization. The browser handoff uses the linked owner session. The native panel holds this private view in memory and clears it on close.

**Email delivery** is available to owners from **Management areas**. Select the server configuration, SMTP, Gmail / Google Workspace, Resend or disabled. Provider changes use the current Cloud revision. Unedited forms refresh as soon as Cloud confirms a change from another session. Open drafts are kept until the owner chooses to reload. Credentials are masked and sent only to the server when saving. They stay out of the local replica and offline queue. Save before sending a test, which goes to the signed-in owner's email address. Reload if Cloud reports a different revision or cannot confirm a save.

## Inventory

**Inventory** searches products by name, SKU or barcode and can include archived products. The detail shows the latest stock and the optional amount and unit of content per pack. Owners and managers can change or clear the pack content without recording a stock movement. Open **Stock history** to see the shared ledger and record deliveries, consumption and physical counts. A count replaces the physical stock in the main warehouse and respects the units reserved for sales. Catalog and idle stock views refresh through sync when connected.

Open **Stock movements** to see the history across products. Search by name, SKU or reason, and combine the movement type with a warehouse filter. **Transfers** shows inter-warehouse movements. Open **Stock movements** from a warehouse to start with its filter applied. Opening a product keeps the filter and page when you return. New movements are announced while you browse. Choose **Show latest movements** to include them and return to page one. **Save CSV** exports the matching rows from the current view using your inventory permissions. This view requires a server connection.

If a connection drops with a product already open, you can save one movement per product on this device. Open the product and choose **Retry the same movement** when connected. Citame keeps the exact request in SQLite through app restarts and uses its original version and key. A version conflict requires reviewing current stock. After a database restore, Citame asks you to review the current stock and history before discarding a rejected request from the previous generation. The full catalog and movement history load from the server.

Open **Warehouses** to see physical and reserved stock by location. Inventory writers can add, rename, archive and reactivate secondary locations and transfer several products at once. Previously loaded pages are available offline. Drafts use the reviewed location and product versions, and saved changes appear as pending until Cloud confirms them. If Cloud reports a conflict, open it from **Sync conflicts** to review current quantities before resubmitting. A transfer that was already recorded keeps its original document ID. To route a new stock receipt or a purchase-order delivery to a secondary location, use **Receiving warehouse**. The selector can refresh the active locations and retains previously loaded locations offline. A receipt remembers the warehouse name in its history even if the location is renamed later. **Adjust stock** records a delivery, internal use or a physical count for a specific product at the selected location. Search by product name or SKU to include products with no stock in a secondary warehouse. Approved adjustments are queued offline and the server checks the reviewed quantity and product version on replay.

Open **Categories and brands** under Inventory to review the current catalogue. Inventory writers can create, archive and reorder entries and choose a parent category. After loading the catalogue, Desktop can queue these changes and product assignments offline. The product editor and the subcategory filter use the same cached entries.

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

This client covers the appointment desk, notifications, waitlist requests, appointment receipts, cash register management, the online unpaid appointments and billing review queue, inventory browsing, product photos, pack content, per-product stock operations, the global stock ledger and CSV, operational, client and financial reports, commission rates, statements and recording completed payouts, sync conflict review, team portraits, schedule templates, dated shifts and general salon settings. Client selection and basic contact management work locally. Advanced client management, team account administration, prepaid plan administration, marketing and provider configuration are available in the web app. The private Booksy consultation environment provides read-only access to the imported calendar.

If an open appointment changes in Cloud, Desktop asks you to review the current appointment before moving it, cancelling it or recording the outcome. Reviewing keeps any proposed time and professional changes. Cancellation requires confirmation again.

If Cloud rejects an appointment edit, Desktop keeps any later queued edits to that appointment in **Sync conflicts**. Open the current appointment from that inbox. Desktop keeps the proposed changes and checks the appointment again before saving. The original conflict stays in the inbox until the new edit is queued or you dismiss it.

In the service catalogue, **Service photos** opens the gallery for an existing service. Choose an image, review its preview, and enter a caption and alternative text. Saving creates a private draft. Publishing requires a separate confirmation. Saving changes to published metadata returns the photo to draft. Requests check both the catalogue generation and the photo's reviewed version. New private drafts saved in Desktop survive restart and upload when it reconnects to a Cloud server that advertises portfolio uploads. Rejected uploads appear in sync conflicts. You can review the original draft and save a local copy of the image if the service is unavailable. Editing or publishing an existing photo requires a connection.

Inventory editors can queue private product photo replacements and removals from reviewed product details while offline. The current Cloud image needs a connection. Pending uploads survive restarts and can be reviewed alongside the current image if Cloud rejects an older version.

Inventory also includes Suppliers and Stock receipts. Editors can prepare and queue changes offline using supplier and product records previously loaded on that device. Open a product in the inventory or select it from the receipt's search while connected to save its reviewed stock version. Previously opened receipt details are available offline to inventory editors without unit costs. A rejected delivery retains its lines for review and checks its original receipt ID before it can be resubmitted.

Purchase orders share that queue. Drafts, placement, cancellation, and linked partial or complete receipts use the reviewed order version. The device can reopen cached order details offline and prepare changes with reviewed products and suppliers. A concurrent Cloud delivery preserves the pending quantities for explicit review against the updated balance. Each order accepts one pending operation at a time. To start the next step, let the previous change synchronize so the new operation uses the confirmed order version.

**Marketing → Loyalty → Stamp card programme** lets the owner edit stamp rules, treatment eligibility, reward and validity. Review the programme and choose how to handle previous cards before saving. Staff with the appropriate permissions can manage individual cards after choosing a client in Loyalty. Programme and card writes require a connection to Cloud. **Marketing → Loyalty → Manage stamp cards** lets owners preview and void matching cards in bulk while retaining their history. **Notifications → Reward notifications** shows earned rewards, links to the client card and keeps read status shared with Cloud for the same account.

**Cash register → New sale** creates an online walk-in receipt with catalog products, services or custom items. Review server prices and stock before taking cash or registering an external card payment. Receipts with unresolved catalog prices require the final amounts before collection. **Cash register → Transactions** lets operators search, filter and reopen receipts to review or continue collection. Authorized operators can record partial or full refunds of cash, external-card and gift card payments and void eligible unpaid receipts. On a fulfilled product sale, **Return to stock** records the units physically brought back. A monetary refund is a separate action. Reopen the receipt after a restart to verify an unconfirmed stock return with the same request.

Choose **Print receipt** to open the reviewed receipt in the system browser, then choose the printer or save a PDF using the browser's print dialog. The preview runs locally and can open without a Cloud connection when the receipt is already visible. It only contains the receipt, including the salon-local issue time, line items and recorded amounts. Reopen **Print receipt** for a fresh preview after closing or reloading the browser page.

For appointment receipts with a variable price or an advertised minimum, an authorized operator can enter the final amounts in the desktop app while online. The server checks the receipt revision and minimums before enabling collection. A deposit allowed by the booking policy remains collectible at the amount set by the server.

**Manage online** opens the cloud management areas available to the signed-in account. Choose an area to open its original Citame page in the system browser. The linked device signs the requested destination, and Citame grants the browser a session for that same account through a one-use ticket. The calendar shortcut preserves the selected date and view.

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
