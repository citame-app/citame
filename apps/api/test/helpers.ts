import {
  clientProfile,
  type Database,
  salonSettings,
  service,
  serviceStaff,
  staffProfile,
  workingHours,
} from "@sob/db";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { type AppConfig, loadConfig } from "../src/config";
import { createTestValkey, type TestValkey } from "./valkey";

/** Fixed clock for deterministic availability: a Monday, 09:00 in Buenos Aires. */
export const NOW = new Date("2026-03-02T12:00:00Z");
/** The following Monday. Buenos Aires is UTC-3, so 09:00 local is 12:00Z. */
export const MONDAY = "2026-03-09";
export const MONDAY_0900 = "2026-03-09T12:00:00.000Z";

export interface Fixtures {
  haircutId: string;
  colorId: string;
  anaId: string;
  beaId: string;
  clientId: string;
}

export const TEST_SECRET = "test-secret-test-secret-test-secret-0123";

export interface ApiTest extends TestDatabase {
  app: Hono;
  valkey: TestValkey;
  config: AppConfig;
  /** Epoch-ms clock used by the rate limiter; move it to cross window boundaries. */
  clock: { now: () => number; advance: (seconds: number) => void };
}

export interface SetupOptions {
  env?: Record<string, string>;
}

export async function setupApiTest(options: SetupOptions = {}): Promise<ApiTest> {
  const t = await createTestDatabase("api");
  const valkey = await createTestValkey("api");
  const config = loadConfig({
    BETTER_AUTH_SECRET: TEST_SECRET,
    VALKEY_KEY_PREFIX: valkey.prefix,
    // Generous by default so only the rate-limit tests ever hit a limit.
    RATE_LIMIT_GLOBAL_MAX: "100000",
    RATE_LIMIT_AUTH_MAX: "100000",
    ...options.env,
  });
  let nowMs = Date.parse("2026-03-02T12:00:00Z");
  const clock = {
    now: () => nowMs,
    advance: (seconds: number) => {
      nowMs += seconds * 1000;
    },
  };
  const app = createApp({
    db: t.db,
    valkey: valkey.client,
    config,
    now: () => NOW,
    rateLimitNow: clock.now,
  });
  const closeDb = t.close;
  const resetDb = t.reset;
  const close = async () => {
    await closeDb();
    await valkey.close();
  };
  const reset = async () => {
    await resetDb();
    await valkey.clear();
  };
  return Object.assign(t, { app, valkey, config, clock, close, reset });
}

/**
 * Salon in Buenos Aires (30 min grid), two services, two staff members with Monday
 * hours 09:00-18:00. Ana performs both services, Bea only the haircut.
 * Haircut = 45 min + 15 min buffer (60 block); color = 90 min + 0 buffer.
 */
export async function seedFixtures(db: Database): Promise<Fixtures> {
  await db.insert(salonSettings).values({
    name: "Test Salon",
    timezone: "America/Argentina/Buenos_Aires",
    slotGranularityMinutes: 30,
    minNoticeMinutes: 60,
    maxDaysAhead: 90,
  });
  const [haircut, color] = await db
    .insert(service)
    .values([
      { name: "Haircut", durationMinutes: 45, bufferMinutes: 15, priceCents: 10000 },
      { name: "Color", durationMinutes: 90, bufferMinutes: 0, priceCents: 25000 },
    ])
    .returning();
  const [ana, bea] = await db
    .insert(staffProfile)
    .values([{ displayName: "Ana" }, { displayName: "Bea" }])
    .returning();
  const [client] = await db.insert(clientProfile).values({ name: "Lucia" }).returning();
  if (!haircut || !color || !ana || !bea || !client) throw new Error("fixture insert failed");

  await db.insert(serviceStaff).values([
    { serviceId: haircut.id, staffId: ana.id },
    { serviceId: color.id, staffId: ana.id },
    { serviceId: haircut.id, staffId: bea.id },
  ]);
  await db.insert(workingHours).values([
    { staffId: ana.id, weekday: 1, startTime: "09:00", endTime: "18:00" },
    { staffId: bea.id, weekday: 1, startTime: "09:00", endTime: "18:00" },
  ]);

  return {
    haircutId: haircut.id,
    colorId: color.id,
    anaId: ana.id,
    beaId: bea.id,
    clientId: client.id,
  };
}

/** JSON request helper. Sends the app origin so Better Auth treats mutations as same-site. */
export function json(app: Hono, path: string, method: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Turns a response's Set-Cookie headers into a Cookie request header value. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c): c is string => !!c && !c.endsWith("="))
    .join("; ");
}

export const PASSWORD = "correct horse battery staple";

/** Signs a client up through the public endpoint and returns its session cookie. */
export async function signUp(app: Hono, email: string, name = "Test User", password = PASSWORD) {
  const res = await json(app, "/api/auth/sign-up/email", "POST", { email, name, password });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieFrom(res), userId: body.user.id };
}

export async function signIn(app: Hono, email: string, password = PASSWORD) {
  const res = await json(app, "/api/auth/sign-in/email", "POST", { email, password });
  return { res, cookie: cookieFrom(res) };
}

/** Number of overlapping pairs among non-cancelled appointments of the same staff member. */
export async function countOverlaps(db: Database): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from appointment a
    join appointment b
      on a.staff_id = b.staff_id and a.id < b.id
     and a.status <> 'cancelled' and b.status <> 'cancelled'
     and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
  `);
  return rows[0]?.n ?? -1;
}
