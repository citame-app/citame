# Connecting an AI assistant to Citame (MCP)

The API is also a [Model Context Protocol](https://modelcontextprotocol.io) server. An assistant signs in as a real user through OAuth 2.1, and everything it does is limited by that user's role. Design and threat model: [ADR 0009](adr/0009-oauth-and-mcp.md).

## Endpoints

With `BETTER_AUTH_URL=https://salon.example` (the public origin of the web app):

| What                                                    | URL                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| MCP server (Streamable HTTP, stateless, JSON responses) | `https://salon.example/mcp`                                             |
| Protected resource metadata (RFC 9728)                  | `https://salon.example/.well-known/oauth-protected-resource/mcp`        |
| Authorization server metadata (RFC 8414)                | `https://salon.example/.well-known/oauth-authorization-server/api/auth` |
| Dynamic client registration (RFC 7591)                  | `https://salon.example/api/auth/oauth2/register`                        |

A host that only knows the MCP URL discovers the rest: an unauthenticated call gets `401` with `WWW-Authenticate: Bearer resource_metadata="..."`, the metadata names the authorization server, the host registers itself, runs authorization code + PKCE (`S256` only) and sends `Authorization: Bearer <token>` with every request.

## Connect a host

- **Claude Desktop / Claude.ai (custom connector)**: add a remote MCP server with the URL `https://salon.example/mcp`. The host opens the browser; sign in (or create an account) and review the consent screen.
- **MCP Inspector** (`npx @modelcontextprotocol/inspector`): transport "Streamable HTTP", URL `https://salon.example/mcp`, then "Open Auth Settings" and run the guided OAuth flow. If the browser connects directly to `/mcp`, configure its exact origin in `MCP_ALLOWED_ORIGINS`. Native clients and server-side connectors can connect without an Origin header.
- **Any host with a config file**: `{ "mcpServers": { "salon": { "type": "http", "url": "https://salon.example/mcp" } } }` (the key names differ per host; the URL is what matters).
- **Local development**: with the API on `http://localhost:3000` (and no web proxy) everything is on `http://localhost:3000`, including `/sign-in` and `/consent`, which only exist in apps/web: run the web app and set `BETTER_AUTH_URL` to its origin so the login and consent pages are reachable (see the README for the stack).

Hosts must send the RFC 8707 `resource` parameter (the MCP URL) when authorizing. Tokens issued without it are opaque and `/mcp` rejects them.

## Consent screen and scopes

| Scope                                           | What the user is told                                        | Tools                                                        |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `mcp:read`                                     | View services, availability and the appointments you can see | `list_services`, `find_availability`, `list_my_appointments`, `quote_appointment_price` |
| `mcp:book`                                      | Book and cancel your own appointments as a customer          | `create_appointment`, `cancel_appointment`                   |
| `schedule:read` (staff and owner accounts only) | Read the staff schedule and look up clients                  | `list_schedule`, `find_client`                               |
| `offline_access`                                | Stay connected until you remove access                       | refresh tokens                                               |

A token's powers are the intersection of its scopes, the current consent, the registered client and the user's current role and access preset. Citame checks them on every call. Access tokens last 15 minutes; hosts refresh them with a rotating refresh token (14 days).

## Centre management

Management permissions must be selected explicitly in the consent screen. The OAuth server rejects management and staff schedule scopes for customer accounts at consent and token issuance. If a client was previously registered only with booking scopes, register it with the additional scopes and connect it again. A browser session cookie cannot call MCP.

| Scope | Operations |
| --- | --- |
| `operations:read` | Calendar and booking indicators, recurring-series preview and lookup, team and staff capacity, schedules and exceptions, waiting lists and individual offer review, contacts, full service catalogue and treatment combinations, resources, stock ledger, unpaid appointments, sales and cash summaries, reports, package and membership periods, gift-card balances and movements, staff commission policies and statements, loyalty points and promotion terms, campaign status, centre settings and appointment inbox |
| `schedule:write` | Book, move and cancel centre appointments, create reviewed recurring series, record outcomes, create/edit/remove blocks, replace regular hours, set staff capacity, review and apply date-specific shifts, add/cancel waitlist entries, accept or requeue reviewed offers and archive or restore your appointment notices |
| `clients:write` | Create and edit contacts |
| `catalog:write` | Create/edit services, variants, add-ons, treatment combinations, assignments, processing intervals and equipment requirements, existing staff profiles, resources, benefit plans, checkout promotions and unqueued marketing drafts |
| `stock:write` | Create and edit products, record deliveries, use and stock counts |
| `sales:write` | Create idempotent checkout drafts for services, products, packages, manual-renewal memberships and gift cards, and discard unpaid drafts |
| `billing:write` | Save verified prices for imported appointments and reconcile full or partial payments already made in Booksy. Available to the owner only. |
| `cash:write` | Open and close the cash register, record physical cash deposits and withdrawals, record confirmed cash or external card receipts |
| `commissions:write` | Update versioned commission rates and record payouts already made outside Citame. Requires the account's commission-management permission. |
| `settings:write` | Change owner settings, the booking, waiting-list and loyalty policies and WhatsApp appointment rules |

The web service still enforces its own resource ownership, role checks, reviewed versions and replay keys. Managed responses wrap their validated result in `structuredContent.data`. Cash recording accepts only `cash` or `external_card`. Online charges, automatic membership renewals, refunds, issuing redemption codes, sending marketing campaigns, account and role administration, bulk exports and customer documents remain dashboard operations. The MCP profile strips internal notes and sensitive fields from its projections, including tax/address details in contact listings, waiting-list offer details in the general queue and bank references in checkout and commission summaries.

Read weekly hours with `get_working_hours` and pass its revision as `body.expectedRevision` to `replace_working_hours`. This uses the same schedule editing permission as Web. Owners can read `get_centre_settings` and pass its revision and the proposed fields in `body: { expectedRevision, changes }` to `update_centre_settings`. If a tool reports a conflict, read the current values and review the change again.

To turn a waiting-list offer into a booking, call `list_waitlist`, then `review_waitlist_offer` for one entry. Review its time, staff, total, expiry and deposit policy with the operator. With `schedule:write`, pass the exact offer ID, version, total and any applicable saved-form references to `accept_waitlist_offer`. Use `requeue_waitlist_offer` to release the slot and let the worker look for another one. New form answers and deposit waivers are handled in the web desk.

To book for a client, approve `schedule:write`, look up the client, service and availability, and call `create_appointment` with the approved slot and a stable `requestId`. Pass `professionalPreference: "specific"` when the client requested the selected professional. To cancel from a staff or owner account, first read the appointment and pass its current `version` with `appointmentId` to `cancel_appointment`. Older staff or owner connections that only granted `mcp:book` must reconnect with `schedule:write` to book or cancel for the centre.

To move a booking, read its version and original service IDs with `get_calendar`. Pass those IDs in booking order to `find_reschedule_availability` with the desired date. After the operator approves a returned time and professional, submit the version and changes to `update_appointment` with `schedule:write`.

For an imported booking with an unknown price, an owner can use `get_imported_price_review` to retrieve the current appointment version and the affected service lines. After checking the original quote, use `record_imported_price_review` with `billing:write` to save each verified amount in cents. Citame preserves the source price and blocks the review when Booksy shows payment or invoicing or Citame already has an active checkout.

For a payment already made in Booksy, use `get_imported_settlement` or `get_imported_partial_payment` with `operations:read`. The owner checks the original receipt and confirms the appointment, current version, verified amount in euro cents and evidence reference. Submit those values to `record_imported_settlement` or `record_imported_partial_payment` with `billing:write`. A full settlement removes the appointment from checkout. For a partial payment, checkout collects only what remains due. Citame keeps the evidence reference in its business audit and omits it from MCP responses.

For recurring bookings, `preview_appointment_series` calculates the dates, availability and price. `create_appointment_series` takes the same reviewed input, its review hash and a stable idempotency key. Citame books the entire series in one transaction. `get_appointment_series` reads the saved visits.

For catalogue changes, the owner can use `list_catalog_services` and pass the current service version to `configure_service` to save its details, professional assignments and optional variant or add-on settings together. Use `list_service_combinations` to find saved combinations and their versions, `create_service_combination` with a stable idempotency key to create one, and `update_service_combination` with the reviewed version to change or deactivate it.

For physical cash movements, read the active session with `get_cash_session` and confirm the amount, direction and reason with the operator. Call `record_cash_movement` with that session ID and a stable idempotency key. When closing, pass the reviewed expected balance alongside the actual count so intervening movements trigger a version conflict.

Use `get_staff_work_report` with `operations:read`, the professional's `staffId`, and two inclusive local calendar dates for `from` and `to`. The result matches the daily Web and Desktop report and includes a 14-day window starting today in the centre's time zone. Staff with operational report access and their own calendar only can read their own figures. The report includes durations and unavailable intervals. If a long report reaches the 256 KiB MCP response limit, request shorter date ranges.

Approve the exact booking, cash count or other change in the host before calling a write tool. Review a schedule-exception preview before applying its hash. Reuse the same idempotency key for a retry of the same action. Tool annotations are advisory to hosts; OAuth authorization and the normal service checks are enforced by Citame.

## Booking tools

All inputs are validated with Zod schemas from `@sob/contracts`; all successful results include `structuredContent` that matches the tool's `outputSchema`. Failures are results with `isError: true`, a message that says what to do next, and `_meta.error.code`.

| Tool                   | Who          | Annotations     | What it does                                                                                                                                                                                                                         |
| ---------------------- | ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_services`        | any          | read-only       | Services (duration, buffer, price) and the professionals who perform them.                                                                                                                                                           |
| `find_availability`    | any          | read-only       | Free start times for `serviceIds` on one `date` (salon timezone), optionally one `staffId`. Advisory.                                                                                                                                |
| `list_my_appointments` | any          | read-only       | Appointments in a window (default now to +90 days). Clients: their own. Staff: their calendar. Owner: all.                                                                                                                           |
| `create_appointment`   | any          | not destructive | Books `staffId` + `serviceIds` at `startsAt` (copied from a slot). Clients book for themselves; staff and owners pass `clientId` and may only book their own calendar (owners: any). Optional `requestId` (UUID) makes retries safe. |
| `cancel_appointment`   | any          | destructive     | Cancels an appointment. Clients: only their own; a foreign or unknown id is "not found".                                                                                                                                             |
| `list_schedule`        | staff, owner | read-only       | Appointments with client and service names between two instants (max 42 days). Staff: own calendar only.                                                                                                                             |
| `find_client`          | staff, owner | read-only       | Clients by name, phone or email fragment (id, name, phone, email, visit stats; no internal notes).                                                                                                                                   |

Error codes in `_meta.error.code`: `slot_taken` and `slot_unavailable` (call `find_availability` again), `validation_error`, `not_found`, `forbidden` (also used for a missing scope: the message names it), `invalid_state` (already cancelled), `version_conflict`, `internal_error`.

Appointment notes are written by clients, so staff and owner tokens receive `notes: null` in booking tool output (prompt-injection hardening); clients see their own notes. `list_schedule` returns its narrower schedule projection. Comment and billing badges are available through `get_calendar` with `operations:read`.

## Booking flow an assistant should follow

1. `list_services` for ids.
2. `find_availability` for the day the user wants. Call `quote_appointment_price` for the chosen start and show the price of each service, including any surcharge, before confirming. Supply its non-null `review` as `peakPriceReview` only after the customer accepts. If `peak_price_changed` comes back, request a fresh quote and review it again.
3. `create_appointment` with a slot copied exactly and a fresh `requestId`. On `slot_taken` go back to step 2.
4. Confirm to the user. `cancel_appointment` undoes it.

## Operations

- New environment keys: `MCP_RESOURCE_URL` (default `<BETTER_AUTH_URL>/mcp`; change it only if the MCP endpoint is served from another public URL, because it is the token audience), `OAUTH_ACCESS_TOKEN_TTL_SECONDS` (900), `OAUTH_REFRESH_TOKEN_TTL_SECONDS` (1 209 600), `RATE_LIMIT_OAUTH_MAX` / `_WINDOW_SECONDS` (60 / 60), `RATE_LIMIT_OAUTH_REGISTER_MAX` / `_WINDOW_SECONDS` (10 / 60), `RATE_LIMIT_MCP_MAX` / `_WINDOW_SECONDS` (120 / 60).
- If you publish MCP at a custom host or path, forward that endpoint to API `/mcp`. Forward its advertised protected-resource metadata path to the API as well. The OAuth server, login and consent stay at `BETTER_AUTH_URL`.
- Run migrations (`bun run db:migrate`): migration `0005` adds the OAuth tables.
- Audit: `select action, actor_user_id, entity_id, metadata from audit_log where action like 'oauth.%' order by created_at desc;`
- In **My account → Profile → Connected apps** the account holder can review scopes and revoke access for one client. Revocation removes the grant and refresh credentials. Access JWTs are bound to the original grant. After upgrading, hosts with older pre-binding access tokens need to refresh or reconnect once. Set `oauth_client.disabled = true` to block a client for everyone.
- `MCP_ALLOWED_ORIGINS` accepts a comma-separated list of exact browser origins, including scheme and port. The public auth and MCP origins are included automatically. This setting only applies to bearer-authenticated `/mcp` calls. OAuth discovery, registration and the token endpoint retain public CORS without credentials.
- Administrative write attempts record the authenticated user, OAuth client and tool in `audit_log` with action `mcp.write_requested`. Normal business audits record successful mutations.
- In production, `BETTER_AUTH_URL` and `MCP_RESOURCE_URL` require HTTPS. Loopback HTTP is supported for local testing. JWT access tokens are ES256, audience-bound and short-lived. Citame stops accepting MCP calls when its rate limiter cannot be reached.
- Send one JSON-RPC message per MCP HTTP request. The maximum request body is 64 KiB.
- A Booksy consultation copy blocks MCP POST requests. Connect assistants to the operational Citame instance when it is ready.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
