import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auditLog, oauthRefreshToken } from "@sob/db";
import { eq } from "drizzle-orm";
import { type ApiTest, actor, setupApiTest } from "../../test/helpers";
import {
  authorizeFlow,
  MCP_URL,
  ORIGIN,
  obtainTokens,
  pkce,
  REDIRECT_URI,
  registerClient,
  tokenRequest,
} from "../../test/oauth";

let t: ApiTest;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "mcp" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function setup(scope = "mcp:read mcp:book offline_access") {
  const user = await actor(t, "client", "lucia@example.com");
  const { client } = await registerClient(t.app, { scope });
  return { user, clientId: client.client_id, scope };
}

describe("authorization code + PKCE (S256 only)", () => {
  test("a signed-in user approves consent and the client trades the code for tokens", async () => {
    const { user, clientId, scope } = await setup();
    const { tokens } = await obtainTokens(t.app, { clientId, cookie: user.cookie, scope });
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope.split(" ").sort()).toEqual(["mcp:book", "mcp:read", "offline_access"]);
    expect(tokens.refresh_token).toBeString();
    expect(tokens.expires_in).toBeLessThanOrEqual(900);
  });

  test("an unauthenticated authorize request is sent to the sign-in page with a signed query", async () => {
    const { clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, { clientId, cookie: "", scope });
    const location = flow.authorize.headers.get("location") ?? "";
    expect(new URL(location, ORIGIN).pathname).toBe("/sign-in");
    expect(location).toContain("sig=");
    expect(flow.code).toBeNull();
  });

  test("the consent page receives the client, the scopes and a signed query", async () => {
    const { user, clientId, scope } = await setup();
    const pair = await pkce();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope,
      state: "s",
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    });
    const res = await t.app.request(`/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie: user.cookie },
    });
    const url = new URL(res.headers.get("location") ?? "", ORIGIN);
    expect(url.pathname).toBe("/consent");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(url.searchParams.get("sig")).toBeString();
  });

  test.each(["none", "client_secret_basic"])(
    "a dynamically registered %s client needs PKCE even without offline access",
    async (tokenEndpointAuthMethod) => {
      const user = await actor(t, "client", "lucia@example.com");
      const scope = "mcp:read";
      const { res: registration, client } = await registerClient(t.app, {
        scope,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      });
      expect(registration.status).toBe(201);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        scope,
        resource: MCP_URL,
      });
      const res = await t.app.request(`/api/auth/oauth2/authorize?${params}`, {
        headers: { cookie: user.cookie },
      });
      const location = res.headers.get("location") ?? "";
      expect(location).not.toContain("code=");
      expect(location).toContain("error=");
    },
  );

  test("the plain challenge method is rejected", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, {
      clientId,
      cookie: user.cookie,
      scope,
      codeChallenge: "plain-text-challenge-plain-text-challenge-12345",
      challengeMethod: "plain",
    });
    expect(flow.code).toBeNull();
    expect(`${flow.authorize.headers.get("location")}${flow.finalUrl}`).toContain("error");
  });

  test("a wrong code_verifier is rejected with invalid_grant and issues nothing", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, { clientId, cookie: user.cookie, scope });
    const form = {
      grant_type: "authorization_code",
      code: flow.code ?? "",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: MCP_URL,
    };
    const wrong = await tokenRequest(t.app, { ...form, code_verifier: `${flow.verifier}x` });
    expect(wrong.res.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    expect(wrong.body.access_token).toBeUndefined();
  });

  test("a code is single use", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, { clientId, cookie: user.cookie, scope });
    const form = {
      grant_type: "authorization_code",
      code: flow.code ?? "",
      code_verifier: flow.verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: MCP_URL,
    };
    expect((await tokenRequest(t.app, form)).res.status).toBe(200);
    const again = await tokenRequest(t.app, form);
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  test("a different redirect_uri is never honoured (no code is sent to an unregistered URL)", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, {
      clientId,
      cookie: user.cookie,
      scope,
      redirectUri: "http://127.0.0.1:8976/other",
    });
    expect(flow.code).toBeNull();
    const location = flow.authorize.headers.get("location") ?? "";
    expect(location).not.toContain("127.0.0.1:8976/other?code");
  });

  test("a loopback redirect may use any port (RFC 8252)", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, {
      clientId,
      cookie: user.cookie,
      scope,
      redirectUri: "http://127.0.0.1:61234/callback",
    });
    expect(flow.code).toBeString();
    expect(flow.finalUrl?.origin).toBe("http://127.0.0.1:61234");
  });

  test("denying consent returns access_denied and no code", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, {
      clientId,
      cookie: user.cookie,
      scope,
      approve: false,
    });
    expect(flow.code).toBeNull();
    expect(flow.finalUrl?.searchParams.get("error")).toBe("access_denied");
  });

  test("a resource other than the MCP server is refused (RFC 8707)", async () => {
    const { user, clientId, scope } = await setup();
    const flow = await authorizeFlow(t.app, {
      clientId,
      cookie: user.cookie,
      scope,
      resource: "https://evil.example/mcp",
    });
    expect(flow.code).toBeNull();
  });

  test("scopes the client was not registered for are refused", async () => {
    const user = await actor(t, "client", "lucia@example.com");
    const { client } = await registerClient(t.app, { scope: "mcp:read" });
    const flow = await authorizeFlow(t.app, {
      clientId: client.client_id,
      cookie: user.cookie,
      scope: "mcp:read admin:everything",
    });
    expect(flow.code).toBeNull();
  });

  test("the client_credentials grant is disabled: every token belongs to a signed-in user", async () => {
    const { clientId } = await setup();
    const { res } = await tokenRequest(t.app, {
      grant_type: "client_credentials",
      client_id: clientId,
      scope: "mcp:read",
    });
    expect(res.status).toBe(400);
  });
});

describe("refresh tokens", () => {
  test("a refresh token issues new tokens and is rotated", async () => {
    const { user, clientId, scope } = await setup();
    const { tokens } = await obtainTokens(t.app, { clientId, cookie: user.cookie, scope });
    const refreshed = await tokenRequest(t.app, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
      resource: MCP_URL,
    });
    expect(refreshed.res.status).toBe(200);
    expect(refreshed.body.access_token).toBeString();
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
  });

  test("reusing a rotated refresh token is refused and revokes the family", async () => {
    const { user, clientId, scope } = await setup();
    const { tokens } = await obtainTokens(t.app, { clientId, cookie: user.cookie, scope });
    const form = {
      grant_type: "refresh_token",
      client_id: clientId,
      resource: MCP_URL,
    };
    const first = await tokenRequest(t.app, { ...form, refresh_token: tokens.refresh_token ?? "" });
    expect(first.res.status).toBe(200);
    const replay = await tokenRequest(t.app, {
      ...form,
      refresh_token: tokens.refresh_token ?? "",
    });
    expect(replay.res.status).toBe(400);
    const child = await tokenRequest(t.app, {
      ...form,
      refresh_token: String(first.body.refresh_token),
    });
    expect(child.res.status).toBe(400);
  });

  test("refresh tokens are stored hashed", async () => {
    const { user, clientId, scope } = await setup();
    const { tokens } = await obtainTokens(t.app, { clientId, cookie: user.cookie, scope });
    const rows = await t.db.select().from(oauthRefreshToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).not.toBe(tokens.refresh_token);
    expect(tokens.refresh_token).not.toContain(rows[0]?.token ?? "?");
  });

  test("no refresh token without offline_access", async () => {
    const user = await actor(t, "client", "lucia@example.com");
    const { client } = await registerClient(t.app, { scope: "mcp:read" });
    const { tokens } = await obtainTokens(t.app, {
      clientId: client.client_id,
      cookie: user.cookie,
      scope: "mcp:read",
    });
    expect(tokens.refresh_token).toBeUndefined();
  });
});

describe("audit trail of grants", () => {
  test("registration, consent and token issuance are recorded without secrets", async () => {
    const { user, clientId, scope } = await setup();
    const { tokens } = await obtainTokens(t.app, { clientId, cookie: user.cookie, scope });
    const actions = (await t.db.select().from(auditLog)).map((row) => row.action);
    expect(actions).toContain("oauth.client_register");
    expect(actions).toContain("oauth.consent_grant");
    expect(actions).toContain("oauth.token_issue");
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "oauth.consent_grant"));
    expect(rows[0]?.actorUserId).toBe(user.userId);
    expect(rows[0]?.entityId).toBe(clientId);
    const everything = JSON.stringify(await t.db.select().from(auditLog));
    expect(everything).not.toContain(tokens.access_token);
    expect(everything).not.toContain(tokens.refresh_token ?? "?");
  });

  test("a denied consent is recorded as a denial", async () => {
    const { user, clientId, scope } = await setup();
    await authorizeFlow(t.app, { clientId, cookie: user.cookie, scope, approve: false });
    const actions = (await t.db.select().from(auditLog)).map((row) => row.action);
    expect(actions).toContain("oauth.consent_deny");
    expect(actions).not.toContain("oauth.consent_grant");
  });
});
