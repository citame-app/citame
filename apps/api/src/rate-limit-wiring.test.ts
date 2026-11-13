import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { errorResponseSchema } from "@sob/contracts";
import { PASSWORD, setupApiTest, signUp } from "../test/helpers";

const GLOBAL_MAX = 8;
const AUTH_MAX = 3;

let t: Awaited<ReturnType<typeof setupApiTest>>;

beforeAll(async () => {
  t = await setupApiTest({
    env: {
      RATE_LIMIT_GLOBAL_MAX: String(GLOBAL_MAX),
      RATE_LIMIT_GLOBAL_WINDOW_SECONDS: "60",
      RATE_LIMIT_AUTH_MAX: String(AUTH_MAX),
      RATE_LIMIT_AUTH_WINDOW_SECONDS: "60",
      TRUST_PROXY: "true",
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  // Start every test at the beginning of a fresh window.
  t.clock.advance(60 - ((t.clock.now() / 1000) % 60));
});

const from = (ip: string) => ({ "x-forwarded-for": ip });
const signIn = (ip: string, password = "wrong password here") =>
  t.app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...from(ip) },
    body: JSON.stringify({ email: "nobody@example.com", password }),
  });

describe("auth endpoints are strictly limited", () => {
  test("the sign-in attempt after the limit is 429 rate_limited with Retry-After", async () => {
    for (let i = 0; i < AUTH_MAX; i++) expect((await signIn("9.9.9.9")).status).toBe(401);

    const blocked = await signIn("9.9.9.9");
    expect(blocked.status).toBe(429);
    expect(errorResponseSchema.parse(await blocked.json()).error.code).toBe("rate_limited");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("sign-up shares the budget with sign-in", async () => {
    for (let i = 0; i < AUTH_MAX - 1; i++) await signIn("9.9.9.9");
    const signup = await t.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        ...from("9.9.9.9"),
      },
      body: JSON.stringify({ email: "x@example.com", name: "X", password: PASSWORD }),
    });
    expect(signup.status).toBe(200);
    expect((await signIn("9.9.9.9")).status).toBe(429);
  });

  test("another client address is unaffected", async () => {
    for (let i = 0; i < AUTH_MAX + 1; i++) await signIn("9.9.9.9");
    expect((await signIn("9.9.9.8")).status).toBe(401);
  });

  test("the budget returns after the window (injected clock)", async () => {
    for (let i = 0; i < AUTH_MAX; i++) await signIn("9.9.9.9");
    expect((await signIn("9.9.9.9")).status).toBe(429);
    t.clock.advance(60);
    expect((await signIn("9.9.9.9")).status).toBe(401);
  });

  test("session reads and sign-out are not counted against the auth budget", async () => {
    const { cookie } = await signUp(t.app, "lucia@example.com");
    t.clock.advance(60);
    for (let i = 0; i < AUTH_MAX; i++) await signIn("9.9.9.7");
    expect((await signIn("9.9.9.7")).status).toBe(429);
    const me = await t.app.request("/me", { headers: { cookie, ...from("9.9.9.7") } });
    expect(me.status).toBe(200);
  });
});

describe("global limit", () => {
  test("N requests pass, N+1 is 429, and the window resets", async () => {
    const hit = () => t.app.request("/services", { headers: from("8.8.8.8") });
    for (let i = 0; i < GLOBAL_MAX; i++) expect((await hit()).status).toBe(200);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(errorResponseSchema.parse(await blocked.json()).error.code).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    t.clock.advance(60);
    expect((await hit()).status).toBe(200);
  });

  test("health checks are never limited", async () => {
    for (let i = 0; i < GLOBAL_MAX + 5; i++) {
      expect((await t.app.request("/health", { headers: from("8.8.4.4") })).status).toBe(200);
    }
  });

  test("limits are per client address", async () => {
    for (let i = 0; i < GLOBAL_MAX + 1; i++)
      await t.app.request("/services", { headers: from("7.7.7.7") });
    expect((await t.app.request("/services", { headers: from("7.7.7.7") })).status).toBe(429);
    expect((await t.app.request("/services", { headers: from("7.7.7.6") })).status).toBe(200);
  });
});

describe("limits are configurable from the environment", () => {
  test("the defaults are moderate globally and strict for auth", async () => {
    const { loadConfig } = await import("./config");
    const defaults = loadConfig({ BETTER_AUTH_SECRET: "x".repeat(32) });
    expect(defaults.rateLimit.auth.max).toBeLessThan(defaults.rateLimit.global.max);
  });
});
