import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@sob/db";
import { RedisClient } from "bun";
import {
  type ApiTest,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../test/helpers";
import { mutation, pull, push, uuid } from "../test/sync";
import { createApp } from "./app";

let t: ApiTest;
let fixtures: Fixtures;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "ops", env: { METRICS_TOKEN: "metrics-token-0123456789" } });
  await t.reset();
  fixtures = await seedFixtures(t.db);
});
afterAll(async () => {
  await t.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  t.app.request(path, { headers });

describe("liveness and readiness", () => {
  test("/health is liveness only: 200 without touching any dependency", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/ready is green when Postgres and Valkey answer", async () => {
    const res = await get("/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe("ready");
    expect(body.checks).toEqual({ database: "ok", valkey: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/ready is 503 and names the failing dependency when Valkey is unreachable", async () => {
    const dead = new RedisClient("redis://127.0.0.1:1", { connectionTimeout: 300, maxRetries: 0 });
    const app = createApp({ db: t.db, valkey: dead, config: t.config, readyTimeoutMs: 800 });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe("unavailable");
    expect(body.checks).toEqual({ database: "ok", valkey: "fail" });
    // Liveness must stay green: restarting the process would not fix a dependency outage.
    expect((await app.request("/health")).status).toBe(200);
    await app.shutdown();
    dead.close();
  });

  test("/ready is 503 when Postgres is unreachable, and never leaks the error text", async () => {
    const broken = createDb("postgres://nobody:nopass@127.0.0.1:1/none");
    const app = createApp({
      db: broken.db,
      valkey: t.valkey.client,
      config: t.config,
      readyTimeoutMs: 800,
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).checks).toEqual({ database: "fail", valkey: "ok" });
    expect(text).not.toContain("nopass");
    await app.shutdown();
    await broken.close().catch(() => {});
  });

  test("probes are never rate limited", async () => {
    const limited = await setupApiTest({
      dbSuffix: "ops_rl",
      env: { RATE_LIMIT_GLOBAL_MAX: "2" },
    });
    try {
      for (let i = 0; i < 6; i++) {
        expect((await limited.app.request("/health")).status).toBe(200);
        expect((await limited.app.request("/ready")).status).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});

describe("/metrics", () => {
  const auth = { authorization: "Bearer metrics-token-0123456789" };

  test("requires the token when one is configured", async () => {
    expect((await get("/metrics")).status).toBe(401);
    expect((await get("/metrics", { authorization: "Bearer wrong-token-0123456789" })).status).toBe(
      401,
    );
    expect((await get("/metrics", auth)).status).toBe(200);
  });

  test("never answers requests that came through the public proxy, even with the token unset", async () => {
    const open = await setupApiTest({ dbSuffix: "ops_open" });
    try {
      expect((await open.app.request("/metrics")).status).toBe(200);
      for (const header of ["x-forwarded-for", "x-forwarded-host", "forwarded"]) {
        const res = await open.app.request("/metrics", { headers: { [header]: "203.0.113.9" } });
        expect(res.status).toBe(404);
      }
    } finally {
      await open.close();
    }
  });

  test("exposes HTTP, booking, sync, notification, database and valkey series", async () => {
    // Generate some traffic first: a successful read and a 404.
    await get("/services");
    await get("/definitely-not-a-route/123");
    const res = await get("/metrics", auth);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    for (const name of [
      "sob_http_requests_total",
      "sob_http_request_duration_seconds_bucket",
      "sob_booking_total",
      "sob_sync_push_mutations_total",
      "sob_sync_pull_requests_total",
      "sob_notifications_sent_total",
      "sob_db_up 1",
      "sob_db_connections",
      "sob_db_pool_max_connections 10",
      "sob_valkey_up 1",
      "process_resident_memory_bytes",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('route="/services"');
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain("definitely-not-a-route");
  });
});

describe("domain counters", () => {
  const scrape = async () =>
    (
      await t.app.request("/metrics", {
        headers: { authorization: "Bearer metrics-token-0123456789" },
      })
    ).text();

  test("booking outcomes are counted per entry point, slot_taken included", async () => {
    const owner = await actor(t, "owner", "metrics-owner@example.com");
    const body = {
      staffId: fixtures.anaId,
      serviceIds: [fixtures.haircutId],
      startsAt: MONDAY_0900,
      clientId: fixtures.clientId,
    };
    expect((await json(t.app, "/appointments", "POST", body, owner.cookie)).status).toBe(201);
    expect((await json(t.app, "/appointments", "POST", body, owner.cookie)).status).toBe(409);
    // Before opening hours: refused by a business rule, not by the exclusion constraint.
    expect(
      (
        await json(
          t.app,
          "/appointments",
          "POST",
          { ...body, startsAt: "2026-03-09T11:00:00.000Z" },
          owner.cookie,
        )
      ).status,
    ).toBe(409);
    const text = await scrape();
    expect(text).toContain('sob_booking_total{source="rest",outcome="created"} 1');
    expect(text).toContain('sob_booking_total{source="rest",outcome="slot_taken"} 1');
    expect(text).toContain('sob_booking_total{source="rest",outcome="rejected"} 1');
  });

  test("sync push and pull are counted, rejections by reason", async () => {
    const owner = await actor(t, "owner", "metrics-sync@example.com");
    const make = (id: string) =>
      mutation("appointment.create", {
        id,
        staffId: fixtures.anaId,
        serviceIds: [fixtures.haircutId],
        startsAt: "2026-03-09T15:00:00.000Z",
        clientId: fixtures.clientId,
      });
    const first = await push(t, owner, [make(uuid())]);
    expect(first.body.results[0]?.status).toBe("applied");
    const second = await push(t, owner, [make(uuid())]);
    expect(second.body.results[0]?.status).toBe("rejected");
    const pulled = await pull(t, owner, { since: 0 });
    const text = await scrape();
    expect(text).toContain('sob_sync_push_mutations_total{status="applied",reason=""} 1');
    expect(text).toContain(
      'sob_sync_push_mutations_total{status="rejected",reason="slot_taken"} 1',
    );
    expect(text).toContain("sob_sync_pull_requests_total 1");
    expect(text).toContain(`sob_sync_pull_changes_total ${pulled.changes.length}`);
  });
});

describe("request ids", () => {
  test("every response carries one and a valid inbound id is propagated", async () => {
    const generated = await get("/services");
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await get("/services", { "x-request-id": "bff-0123456789" });
    expect(echoed.headers.get("x-request-id")).toBe("bff-0123456789");
  });
});

describe("security headers", () => {
  test("API responses are locked down, errors included", async () => {
    for (const path of ["/services", "/me", "/not-a-route"]) {
      const res = await get(path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("permissions-policy")).toContain("camera=()");
      // Plain http in tests: HSTS would be wrong (and ignored) here.
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
  });

  test("HSTS is sent once the deployment is https", async () => {
    const https = await setupApiTest({
      dbSuffix: "ops_https",
      env: { BETTER_AUTH_URL: "https://salon.example", TRUSTED_ORIGINS: "http://localhost:3000" },
    });
    try {
      const res = await https.app.request("/services");
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    } finally {
      await https.close();
    }
  });

  test("session cookies are HttpOnly, SameSite=Lax and Secure with the __Secure- prefix in production", async () => {
    const prod = await setupApiTest({
      dbSuffix: "ops_cookie",
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://salon.example",
        TRUSTED_ORIGINS: "http://localhost:3000",
      },
    });
    try {
      await prod.reset();
      await seedFixtures(prod.db);
      await actor(prod, "owner", "owner@example.com");
      const res = await json(prod.app, "/api/auth/sign-in/email", "POST", {
        email: "owner@example.com",
        password: "correct horse battery staple",
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token"));
      expect(cookie).toBeDefined();
      expect(cookie).toStartWith("__Secure-");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
    } finally {
      await prod.close();
    }
  });
});

describe("origin check on cookie-authenticated mutations", () => {
  test("a browser request from a foreign origin is refused before it reaches any handler", async () => {
    const owner = await actor(t, "owner", "origin-owner@example.com");
    const evil = await t.app.request("/admin/settings", {
      method: "PATCH",
      headers: {
        origin: "https://evil.example",
        cookie: owner.cookie,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  test("the app's own origin and origin-less clients (desktop, curl) are not affected", async () => {
    const owner = await actor(t, "owner", "origin-owner2@example.com");
    const same = await t.app.request("/admin/settings", {
      method: "PATCH",
      headers: {
        origin: "http://localhost:3000",
        cookie: owner.cookie,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(same.status).not.toBe(403);
    const none = await t.app.request("/admin/settings", {
      method: "PATCH",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(none.status).not.toBe(403);
  });

  test("safe methods are never blocked by the origin check", async () => {
    const res = await t.app.request("/services", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });
});
