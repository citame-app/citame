import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { errorResponseSchema } from "@sob/contracts";
import { Hono } from "hono";
import { createTestValkey, type TestValkey } from "../test/valkey";
import { valkeySecondaryStorage } from "./auth/secondary-storage";
import { createLogger } from "./observability/logger";
import { createRateLimiter, rateLimit } from "./rate-limit";

let v: TestValkey;

beforeAll(async () => {
  v = await createTestValkey("rate-limit");
});
afterAll(async () => {
  await v.close();
});
beforeEach(async () => {
  await v.clear();
});

/** A fixed wall clock the test can move. 999_960 s is a multiple of 60, so windows start at 0. */
function clock(startSeconds = 999_960) {
  let nowMs = startSeconds * 1000;
  return {
    now: () => nowMs,
    advance: (seconds: number) => {
      nowMs += seconds * 1000;
    },
  };
}

function setup(options: {
  max: number;
  windowSeconds?: number;
  trustProxy?: boolean;
  scope?: string;
  clock?: ReturnType<typeof clock>;
}) {
  const c = options.clock ?? clock();
  const limiter = createRateLimiter({
    storage: valkeySecondaryStorage(v.client, v.prefix),
    now: c.now,
  });
  const app = new Hono();
  app.use(
    "*",
    rateLimit({
      limiter,
      scope: options.scope ?? "test",
      rule: { max: options.max, windowSeconds: options.windowSeconds ?? 60 },
      trustProxy: options.trustProxy ?? false,
    }),
  );
  app.get("/", (c) => c.json({ ok: true }));
  return { app, clock: c };
}

const get = (app: Hono, headers?: Record<string, string>) => app.request("/", { headers });

describe("fixed-window rate limit", () => {
  test("allows exactly max requests, then answers 429 rate_limited with Retry-After", async () => {
    const { app } = setup({ max: 3 });
    for (let i = 0; i < 3; i++) expect((await get(app)).status).toBe(200);

    const blocked = await get(app);
    expect(blocked.status).toBe(429);
    expect(errorResponseSchema.parse(await blocked.json()).error.code).toBe("rate_limited");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await get(app)).status).toBe(429);
  });

  test("Retry-After is the time left in the current window", async () => {
    const { app, clock: c } = setup({ max: 1 });
    c.advance(15);
    await get(app);
    const blocked = await get(app);
    expect(blocked.headers.get("retry-after")).toBe("45");
  });

  test("the budget resets once the window has passed (injected clock)", async () => {
    const { app, clock: c } = setup({ max: 2 });
    await get(app);
    await get(app);
    expect((await get(app)).status).toBe(429);

    c.advance(59);
    expect((await get(app)).status).toBe(429);

    c.advance(1);
    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(429);
  });

  test("clients behind a trusted proxy are counted separately by their forwarded address", async () => {
    const { app } = setup({ max: 1, trustProxy: true });
    expect((await get(app, { "x-forwarded-for": "10.0.0.1" })).status).toBe(200);
    expect((await get(app, { "x-forwarded-for": "10.0.0.2" })).status).toBe(200);
    expect((await get(app, { "x-forwarded-for": "10.0.0.1" })).status).toBe(429);
  });

  test("the proxy-appended (last) address wins, so a spoofed first entry buys nothing", async () => {
    const { app } = setup({ max: 1, trustProxy: true });
    expect((await get(app, { "x-forwarded-for": "1.1.1.1, 10.0.0.9" })).status).toBe(200);
    expect((await get(app, { "x-forwarded-for": "2.2.2.2, 10.0.0.9" })).status).toBe(429);
  });

  test("X-Forwarded-For is ignored unless the proxy is trusted", async () => {
    const { app } = setup({ max: 1, trustProxy: false });
    expect((await get(app, { "x-forwarded-for": "10.0.0.1" })).status).toBe(200);
    expect((await get(app, { "x-forwarded-for": "10.0.0.2" })).status).toBe(429);
  });

  test("scopes keep independent counters", async () => {
    const shared = clock();
    const a = setup({ max: 1, scope: "a", clock: shared });
    const b = setup({ max: 1, scope: "b", clock: shared });
    expect((await get(a.app)).status).toBe(200);
    expect((await get(b.app)).status).toBe(200);
    expect((await get(a.app)).status).toBe(429);
  });

  test("is atomic under concurrency: exactly max of N parallel requests pass", async () => {
    const { app } = setup({ max: 10 });
    const responses = await Promise.all(Array.from({ length: 40 }, () => get(app)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
  });

  describe("when the store fails", () => {
    const brokenLimiter = createRateLimiter({
      storage: {
        increment: async () => {
          throw new Error("valkey is down");
        },
      },
    });
    const logged: string[] = [];
    const appWith = (failOpen: boolean | undefined) => {
      const app = new Hono();
      app.use(
        "*",
        rateLimit({
          limiter: brokenLimiter,
          scope: "test",
          rule: { max: 1, windowSeconds: 60 },
          trustProxy: false,
          failOpen,
          logger: createLogger({ write: (line) => logged.push(line) }),
        }),
      );
      app.get("/", (c) => c.json({ ok: true }));
      app.onError((_error, c) => c.json({ error: "boom" }, 500));
      return app;
    };

    test("fail-open lets the request through and logs the failure", async () => {
      logged.length = 0;
      const res = await get(appWith(true) as Hono);
      expect(res.status).toBe(200);
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] as string)).toMatchObject({
        level: "error",
        scope: "test",
        msg: "rate limit store failed, failing open",
      });
    });

    test("fail-closed (the default) rejects instead of letting the request through", async () => {
      expect((await get(appWith(false) as Hono)).status).toBe(500);
      expect((await get(appWith(undefined) as Hono)).status).toBe(500);
    });
  });

  test("counters expire in Valkey on their own", async () => {
    const { app } = setup({ max: 5, windowSeconds: 30 });
    await get(app);
    const keys = (await v.client.send("KEYS", [`${v.prefix}rl:*`])) as string[];
    expect(keys).toHaveLength(1);
    const ttl = await v.client.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});
