import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ApiTest, actor, setupApiTest } from "../../test/helpers";
import { rpc, tokenFor } from "../../test/oauth";

let t: ApiTest;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "mcp_exp", env: { OAUTH_ACCESS_TOKEN_TTL_SECONDS: "1" } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe("access token lifetime", () => {
  test("an expired access token is refused with invalid_token", async () => {
    const who = await actor(t, "client", "lucia@example.com");
    const { tokens } = await tokenFor(t, who, "mcp:read");
    expect(tokens.expires_in).toBeLessThanOrEqual(1);
    expect((await rpc(t.app, tokens.access_token, "tools/list")).res.status).toBe(200);
    await Bun.sleep(2100);
    const late = await rpc(t.app, tokens.access_token, "tools/list");
    expect(late.res.status).toBe(401);
    expect(late.res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
