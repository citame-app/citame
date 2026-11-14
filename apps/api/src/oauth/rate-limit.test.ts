import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ApiTest, setupApiTest } from "../../test/helpers";
import { registerClient } from "../../test/oauth";

let t: ApiTest;

beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "mcp_rl",
    env: {
      RATE_LIMIT_OAUTH_REGISTER_MAX: "3",
      RATE_LIMIT_OAUTH_MAX: "2",
      RATE_LIMIT_MCP_MAX: "2",
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe("OAuth rate limits", () => {
  test("anonymous client registration is throttled per caller", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await registerClient(t.app)).res.status);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });

  test("the token endpoint is throttled and answers 429 with Retry-After", async () => {
    const hit = () =>
      t.app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "x" }),
      });
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 4; i++) {
      last = await hit();
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 2).every((s) => s === 400 || s === 401)).toBe(true);
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect(last?.headers.get("retry-after")).toBeString();
  });
});
