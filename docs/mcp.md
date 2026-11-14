# Connecting an AI assistant (MCP)

The API is also a [Model Context Protocol](https://modelcontextprotocol.io) server. An assistant signs in as a real user through OAuth 2.1, and everything it does is limited by that user's role. Design and threat model: [ADR 0009](adr/0009-oauth-and-mcp.md).

## Endpoints

With `BETTER_AUTH_URL=https://salon.example` (the public origin of the web app):

| What | URL |
| --- | --- |
| MCP server (Streamable HTTP, stateless, JSON responses) | `https://salon.example/mcp` |
| Protected resource metadata (RFC 9728) | `https://salon.example/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata (RFC 8414) | `https://salon.example/.well-known/oauth-authorization-server/api/auth` |
| Dynamic client registration (RFC 7591) | `https://salon.example/api/auth/oauth2/register` |

A host that only knows the MCP URL discovers the rest: an unauthenticated call gets `401` with `WWW-Authenticate: Bearer resource_metadata="..."`, the metadata names the authorization server, the host registers itself, runs authorization code + PKCE (`S256` only) and sends `Authorization: Bearer <token>` with every request.

## Connect a host

- **Claude Desktop / Claude.ai (custom connector)**: add a remote MCP server with the URL `https://salon.example/mcp`. The host opens the browser; sign in (or create an account) and review the consent screen.
- **MCP Inspector** (`npx @modelcontextprotocol/inspector`): transport "Streamable HTTP", URL `https://salon.example/mcp`, then "Open Auth Settings" and run the guided OAuth flow. Browser-based hosts work because metadata, registration and the token endpoint allow cross-origin calls without credentials.
- **Any host with a config file**: `{ "mcpServers": { "salon": { "type": "http", "url": "https://salon.example/mcp" } } }` (the key names differ per host; the URL is what matters).
- **Local development**: with the API on `http://localhost:3000` (and no web proxy) everything is on `http://localhost:3000`, including `/sign-in` and `/consent`, which only exist in apps/web: run the web app and set `BETTER_AUTH_URL` to its origin so the login and consent pages are reachable (see the README for the stack).

Hosts must send the RFC 8707 `resource` parameter (the MCP URL) when authorizing. Tokens issued without it are opaque and `/mcp` rejects them.

## Consent screen and scopes

| Scope | What the user is told | Tools |
| --- | --- | --- |
| `mcp:read` (always on) | View services, availability and the appointments you can see | `list_services`, `find_availability`, `list_my_appointments` |
| `mcp:book` | Book and cancel appointments for you | `create_appointment`, `cancel_appointment` |
| `schedule:read` (staff and owner accounts only) | Read the staff schedule and look up clients | `list_schedule`, `find_client` |
| `offline_access` | Stay connected until you remove access | refresh tokens |

A token's powers are the intersection of its scopes and the user's current role, checked on every call. Access tokens last 15 minutes; hosts refresh them with a rotating refresh token (14 days).

## Tools

All inputs are validated with Zod schemas from `@sob/contracts`; all successful results include `structuredContent` that matches the tool's `outputSchema`. Failures are results with `isError: true`, a message that says what to do next, and `_meta.error.code`.

| Tool | Who | Annotations | What it does |
| --- | --- | --- | --- |
| `list_services` | any | read-only | Services (duration, buffer, price) and the professionals who perform them. |
| `find_availability` | any | read-only | Free start times for `serviceIds` on one `date` (salon timezone), optionally one `staffId`. Advisory. |
| `list_my_appointments` | any | read-only | Appointments in a window (default now to +90 days). Clients: their own. Staff: their calendar. Owner: all. |
| `create_appointment` | any | not destructive | Books `staffId` + `serviceIds` at `startsAt` (copied from a slot). Clients book for themselves; staff and owners pass `clientId` and may only book their own calendar (owners: any). Optional `requestId` (UUID) makes retries safe. |
| `cancel_appointment` | any | destructive | Cancels an appointment. Clients: only their own; a foreign or unknown id is "not found". |
| `list_schedule` | staff, owner | read-only | Appointments with client and service names between two instants (max 42 days). Staff: own calendar only. |
| `find_client` | staff, owner | read-only | Clients by name, phone or email fragment (id, name, phone, email, visit stats; no internal notes). |

Error codes in `_meta.error.code`: `slot_taken` and `slot_unavailable` (call `find_availability` again), `validation_error`, `not_found`, `forbidden` (also used for a missing scope: the message names it), `invalid_state` (already cancelled), `version_conflict`, `internal_error`.

Appointment notes are written by clients, so staff and owner tokens receive `notes: null` in tool output (prompt-injection hardening); clients see their own notes.

## Booking flow an assistant should follow

1. `list_services` for ids.
2. `find_availability` for the day the user wants.
3. `create_appointment` with a slot copied exactly and a fresh `requestId`. On `slot_taken` go back to step 2.
4. Confirm to the user. `cancel_appointment` undoes it.

## Operations

- New environment keys: `MCP_RESOURCE_URL` (default `<BETTER_AUTH_URL>/mcp`; change it only if the MCP endpoint is served from another public URL, because it is the token audience), `OAUTH_ACCESS_TOKEN_TTL_SECONDS` (900), `OAUTH_REFRESH_TOKEN_TTL_SECONDS` (1 209 600), `RATE_LIMIT_OAUTH_MAX` / `_WINDOW_SECONDS` (60 / 60), `RATE_LIMIT_OAUTH_REGISTER_MAX` / `_WINDOW_SECONDS` (10 / 60), `RATE_LIMIT_MCP_MAX` / `_WINDOW_SECONDS` (120 / 60).
- Run migrations (`bun run db:migrate`): migration `0005` adds the OAuth tables.
- Audit: `select action, actor_user_id, entity_id, metadata from audit_log where action like 'oauth.%' order by created_at desc;`
- Cut off one app: delete its row in `oauth_consent` for a user (their tokens stop working at once), or set `oauth_client.disabled = true` for everybody.
- There is no account screen to list or revoke grants yet (follow-up in ADR 0009).
