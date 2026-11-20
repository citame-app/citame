import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { appointment, auditLog, oauthClient } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  type ApiTest,
  actor,
  type Fixtures,
  MONDAY,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";

/**
 * The whole story against a running server, with the official MCP TypeScript SDK as the client:
 * discovery (RFC 9728 -> RFC 8414), dynamic registration, authorization code + PKCE with the
 * user signed in and approving consent, then tool calls over Streamable HTTP.
 */

const REDIRECT = "http://127.0.0.1:8976/callback";

let t: ApiTest;
let fx: Fixtures;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  t = await setupApiTest({
    dbSuffix: "mcp_e2e",
    // The shared test helpers sign users in with the default test origin.
    env: { BETTER_AUTH_URL: origin, TRUSTED_ORIGINS: `${origin},http://localhost:3000` },
  });
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (request, srv) => t.app.fetch(request, srv),
  });
});
afterAll(async () => {
  await server.stop(true);
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  fx = await seedFixtures(t.db);
});

/** An in-memory OAuth client, the way an MCP host implements the SDK's provider interface. */
class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  registrations = 0;
  constructor(readonly scope = "mcp:read mcp:book offline_access") {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "e2e MCP host",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.scope,
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.registrations += 1;
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The signed-in user's browser: follows the authorize redirect and approves the consent page. */
async function approveInBrowser(authorizationUrl: URL, user: Pick<Actor, "cookie">, scope: string) {
  const authorize = await fetch(authorizationUrl, {
    redirect: "manual",
    headers: { cookie: user.cookie },
  });
  const consentUrl = new URL(authorize.headers.get("location") ?? "", origin);
  expect(consentUrl.pathname).toBe("/consent");
  const consent = await fetch(`${origin}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: user.cookie, origin },
    body: JSON.stringify({ accept: true, scope, oauth_query: consentUrl.search.slice(1) }),
  });
  const { url } = (await consent.json()) as { url: string };
  const redirect = new URL(url);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe(authorizationUrl.searchParams.get("state"));
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error(`no authorization code in ${url}`);
  return code;
}

function newTransport(provider: TestProvider) {
  return new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
}

/** Connects an SDK client, running the full OAuth dance on the first 401. */
async function connect(user: Pick<Actor, "cookie">, provider = new TestProvider()) {
  let transport = newTransport(provider);
  let client = new Client({ name: "e2e", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    const authorizationUrl = provider.authorizationUrl;
    if (!authorizationUrl) throw new Error("the SDK never asked to authorize", { cause: error });
    const code = await approveInBrowser(authorizationUrl, user, provider.scope);
    await transport.finishAuth(code);
    transport = newTransport(provider);
    client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transport);
  }
  return { client, provider, transport };
}

async function appointments(): Promise<(typeof appointment.$inferSelect)[]> {
  return t.db.select().from(appointment);
}

describe("MCP client end to end over HTTP", () => {
  test("discovers, registers, authorizes with PKCE, books, replays and cancels", async () => {
    const lucia = await actor(t, "client", "lucia@example.com");
    const { client, provider } = await connect(lucia);

    // Dynamic registration happened exactly once, as a public client.
    expect(provider.registrations).toBe(1);
    const registered = await t.db.select().from(oauthClient);
    expect(registered).toHaveLength(2); // the desktop client and the one just registered
    const dcr = registered.find((row) => row.clientId !== "sob-desktop");
    expect(dcr?.clientSecret ?? null).toBeNull();
    expect(dcr?.tokenEndpointAuthMethod).toBe("none");
    expect(provider.saved?.access_token).toBeString();
    expect(provider.saved?.refresh_token).toBeString();

    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_appointment",
      "create_appointment",
      "find_availability",
      "list_my_appointments",
      "list_services",
    ]);
    const cancel = tools.find((tool) => tool.name === "cancel_appointment");
    expect(cancel?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "find_availability")?.annotations?.readOnlyHint).toBe(
      true,
    );

    const slots = await client.callTool({
      name: "find_availability",
      arguments: { serviceIds: [fx.haircutId], date: MONDAY },
    });
    const free = (slots.structuredContent as { slots: { staffId: string; startsAt: string }[] })
      .slots;
    expect(free.length).toBeGreaterThan(0);
    const slot = free[0];
    if (!slot) throw new Error("no slot");

    const requestId = Bun.randomUUIDv7();
    const booked = await client.callTool({
      name: "create_appointment",
      arguments: {
        staffId: slot.staffId,
        serviceIds: [fx.haircutId],
        startsAt: slot.startsAt,
        requestId,
      },
    });
    expect(booked.isError).not.toBe(true);
    const created = booked.structuredContent as { appointment: { id: string }; replayed: boolean };
    expect(created.appointment.id).toBe(requestId);

    const rows = await appointments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(requestId);
    expect(rows[0]?.clientId).toBe(lucia.clientId ?? "");
    expect(rows[0]?.status).toBe("booked");

    // Replay with the same requestId: same appointment, no duplicate.
    const replay = await client.callTool({
      name: "create_appointment",
      arguments: {
        staffId: slot.staffId,
        serviceIds: [fx.haircutId],
        startsAt: slot.startsAt,
        requestId,
      },
    });
    expect((replay.structuredContent as { replayed: boolean }).replayed).toBe(true);
    expect(await appointments()).toHaveLength(1);

    const mine = await client.callTool({
      name: "list_my_appointments",
      arguments: { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
    });
    expect((mine.structuredContent as { appointments: unknown[] }).appointments).toHaveLength(1);

    const cancelled = await client.callTool({
      name: "cancel_appointment",
      arguments: { appointmentId: requestId },
    });
    expect(cancelled.isError).not.toBe(true);
    expect((await appointments())[0]?.status).toBe("cancelled");

    const audit = await t.db.select().from(auditLog).where(eq(auditLog.entity, "appointment"));
    expect(audit.map((row) => row.action).sort()).toEqual([
      "appointment.cancel",
      "appointment.create",
    ]);
    expect(audit.every((row) => (row.metadata as { via?: unknown }).via !== undefined)).toBe(true);
    await client.close();
  });

  test("the SDK refreshes an expired access token on its own", async () => {
    const lucia = await actor(t, "client", "lucia@example.com");
    const { client, provider } = await connect(lucia);
    const firstAccess = provider.saved?.access_token;
    // Pretend the access token was lost: the SDK must use the refresh token (OAuth 2.1 rotation).
    const refresh = provider.saved?.refresh_token;
    provider.saved = {
      ...provider.saved,
      token_type: "Bearer",
      access_token: "stale",
      refresh_token: refresh,
    };
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(provider.saved?.access_token).not.toBe("stale");
    expect(provider.saved?.access_token).not.toBe(firstAccess);
    expect(provider.saved?.refresh_token).not.toBe(refresh);
    await client.close();
  });

  test("two MCP clients race for one slot: one books, the other gets an actionable error", async () => {
    const a = await actor(t, "client", "a@example.com");
    const b = await actor(t, "client", "b@example.com");
    const [one, two] = [await connect(a), await connect(b)];
    const args = {
      staffId: fx.anaId,
      serviceIds: [fx.colorId],
      startsAt: `${MONDAY}T12:00:00.000Z`,
    };
    const results = await Promise.all([
      one.client.callTool({ name: "create_appointment", arguments: args }),
      two.client.callTool({ name: "create_appointment", arguments: args }),
    ]);
    const wins = results.filter((r) => r.isError !== true);
    const losses = results.filter((r) => r.isError === true);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const loser = losses[0];
    if (!loser) throw new Error("expected one loser");
    const text = (loser.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("find_availability");
    expect((loser._meta as { error: { code: string } }).error.code).toBe("slot_taken");
    expect(await appointments()).toHaveLength(1);
    await one.client.close();
    await two.client.close();
  });

  test("a staff member authorizes read-only front-desk management over HTTP", async () => {
    const ana = await actor(t, "staff", "ana@example.com", { staffProfileId: fx.anaId });
    const provider = new TestProvider("mcp:read schedule:read operations:read offline_access");
    const { client } = await connect(ana, provider);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_schedule");
    expect(names).toContain("find_client");
    expect(names).toContain("list_calendar_notices");
    expect(names).not.toContain("set_calendar_notices_archived");
    expect(names).not.toContain("get_loyalty_policy");
    const found = await client.callTool({ name: "find_client", arguments: { search: "Lucia" } });
    expect((found.structuredContent as { clients: { name: string }[] }).clients[0]?.name).toBe(
      "Lucia",
    );
    const inbox = await client.callTool({ name: "list_calendar_notices", arguments: {} });
    expect(inbox.structuredContent).toEqual({
      data: { entries: [], total: 0, page: 1, pageSize: 25 },
    });
    await client.close();
  });

  test("no consent, no access: a client the user never approved cannot call tools", async () => {
    await actor(t, "client", "lucia@example.com");
    const provider = new TestProvider();
    const transport = newTransport(provider);
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.saved).toBeUndefined();
  });
});
