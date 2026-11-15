# Sisters of Beauty desktop client

Offline-first front-desk client in Rust: a GPUI app over a GUI-free core crate. Decisions and rationale: [ADR 0008](../../docs/adr/0008-desktop-client.md). The protocol it implements: [docs/sync-protocol.md](../../docs/sync-protocol.md).

```text
apps/desktop
  crates/core   sob-core: SQLite store + outbox, sync engine, runner, HTTP/SSE, auth, calendar model, i18n
  crates/app    sob-desktop: GPUI shell (login, day/week calendar, booking, conflicts, sync status, light/dark theme)
  vendor/xattr  one-line patch so gpui compiles on current Linux toolchains (see the ADR)
```

## Build and run

Rust stable with edition 2024 support (developed on 1.98). The core needs only a C compiler (bundled SQLite). The GPUI crate also needs the Linux graphics stack: Wayland or X11 client libraries, `xkbcommon(-x11)`, `fontconfig`, `freetype`, a Vulkan loader, `openssl` and `zstd` headers, and `cmake`/`pkg-config`. On Debian or Ubuntu (the package list Zed documents; verified here only in the sense that all of these were already installed when the app was built and run):

```bash
sudo apt install build-essential cmake pkg-config libasound2-dev libfontconfig-dev libwayland-dev \
  libxkbcommon-x11-dev libssl-dev libzstd-dev libvulkan1 mesa-vulkan-drivers
```

```bash
cd apps/desktop
export CARGO_TARGET_DIR=$PWD/target        # already git-ignored; a debug GUI build is ~2 GB
cargo run -p sob-desktop                    # needs a reachable API to sign in for the first time
```

Connection and startup configuration comes from the environment; the theme toggle persists its choice in the data directory:

| Variable            | Default                                    | Meaning                                                                                           |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `SOB_API_URL`       | `http://127.0.0.1:3000`                    | API origin (the web app's origin works too: it proxies `/api/auth`, `/sync`, `/me`)               |
| `SOB_DATA_DIR`      | `$XDG_DATA_HOME/sisters-of-beauty/desktop` | `replica.db` (SQLite) and `session.json` (mode 0600)                                              |
| `SOB_LANG` / `LANG` | English                                    | `es*` selects neutral es-AR                                                                       |
| `SOB_THEME`         | system appearance, then saved choice       | `light`, `dark` or `system`; the header toggle saves its choice to `theme` in the data directory. |
| `SOB_START_DATE`    | today                                      | `YYYY-MM-DD`, open the calendar on that day                                                       |
| `SOB_START_VIEW`    | none                                       | `new`, `details` or `conflicts`: open that dialog at startup (QA and screenshots)                 |

Sign in with an owner or staff account (`bun run bootstrap:owner`, or an owner-created staff account). Once a session is saved the app opens straight into the calendar even without a connection.

Using it: Day view shows one column per staff member; Week view shows Monday to Sunday for the selected member. The header switches views and moves by one day or one week. Text inputs support selection, clipboard shortcuts, grapheme-aware editing and IME composition. In the calendar, "New appointment" books (a new client can be typed in), clicking a booking opens move (time and staff) and cancel, or completed/no-show for a booked appointment that has started. Closed appointments cannot be moved or cancelled. Edits apply locally at once and show a "Pending sync" badge until the server acknowledges them. The header shows online or offline, the last sync (or the retry countdown), the number of pending edits and, when the server refused something (for example the slot was taken meanwhile), a "to review" badge: the conflicts dialog offers another time, dropping the booking or cancelling the appointment, or dismissing the notice.

## Prepare a Linux release locally

```sh
# From the repository root; no registry, remote or production domain is needed.
bun run release:check
(cd apps/desktop && cargo build --release --locked -p sob-desktop)
bash scripts/package-desktop.sh
(cd .release/desktop && sha256sum -c *.sha256)
```

The archive includes the executable, MIT license, this guide and release metadata (source revision and whether the checkout was dirty). Packaging uses deterministic archive metadata and emits a SHA-256 checksum; it does not install or publish. Build and package on the target architecture. See [release.md](../../docs/release.md) for the CI gate and future publishing steps.

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
  cargo test -p sob-core --test headless_sync -- --ignored --test-threads=1
```

`cargo run -p sob-core --example demo_replica -- <data-dir> <api-url> <email> <password>` prepares a data dir with a saved session and a replica holding a synced booking, a lost-slot conflict and a pending offline booking, to look at the GUI in those states (`SOB_DATA_DIR=<data-dir> SOB_START_DATE=<printed day> cargo run -p sob-desktop`).
