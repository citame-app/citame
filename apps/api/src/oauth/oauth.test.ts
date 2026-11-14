import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ApiTest, actor, setupApiTest } from "../../test/helpers";
import { ISSUER, MCP_URL, REDIRECT_URI, registerClient } from "../../test/oauth";

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

describe("authorization server discovery", () => {
  test("RFC 8414 metadata is served at the issuer-derived well-known path", async () => {
    const res = await t.app.request("/.well-known/oauth-authorization-server/api/auth");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(meta.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.scopes_supported).toEqual([
      "mcp:read",
      "mcp:book",
      "schedule:read",
      "offline_access",
    ]);
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
  });
});

describe("dynamic client registration", () => {
  test("an MCP client registers anonymously as a public PKCE client", async () => {
    const { res, client } = await registerClient(t.app);
    expect(res.status).toBe(201);
    expect(client.client_id).toBeString();
    expect(client.client_secret).toBeUndefined();
    expect(client.redirect_uris).toEqual([REDIRECT_URI]);
  });

  test("registration cannot request a scope the server does not offer", async () => {
    const { res } = await registerClient(t.app, { scope: "mcp:read admin:everything" });
    expect(res.status).toBe(400);
  });

  test("registration rejects open redirects (plain http to a non-loopback host)", async () => {
    const { res } = await registerClient(t.app, { redirect_uris: ["http://evil.example/cb"] });
    expect(res.status).toBe(400);
  });
});

describe("browser-based MCP clients (CORS)", () => {
  const origin = "http://localhost:6274";

  test("metadata, JWKS, registration and the token endpoint answer cross-origin without credentials", async () => {
    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/api/auth/jwks"]) {
      const res = await t.app.request(path, { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const registered = await t.app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Inspector",
        redirect_uris: ["http://localhost:6274/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "mcp:read",
      }),
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await t.app.request("/api/auth/oauth2/token", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("cookie-bound endpoints get no CORS headers: another origin cannot read them", async () => {
    const user = await actor(t, "client", "lucia@example.com");
    const res = await t.app.request("/api/auth/oauth2/public-client?client_id=sob-desktop", {
      headers: { origin, cookie: user.cookie },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const consent = await t.app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        cookie: user.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accept: true, oauth_query: "x" }),
    });
    expect(consent.status).toBe(403);
  });
});

describe("pre-registered desktop client", () => {
  test("the desktop public client exists after startup and allows loopback redirects on any port", async () => {
    const user = await actor(t, "client", "desk@example.com");
    const res = await t.app.request("/api/auth/oauth2/public-client?client_id=sob-desktop", {
      headers: { cookie: user.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id: string; client_name: string };
    expect(body.client_id).toBe("sob-desktop");
    expect(body.client_name).toBe("Sisters of Beauty Desktop");
  });
});

export { MCP_URL };
