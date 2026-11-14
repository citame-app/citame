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
