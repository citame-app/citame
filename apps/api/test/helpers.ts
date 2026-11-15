// Access logs would drown the test output; tests that assert on logs inject their own logger.
process.env.LOG_LEVEL ??= "silent";

import type { UserRole } from "@sob/contracts";
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
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type App, type AppDeps, createApp } from "../src/app";
import { createAccount } from "../src/auth/accounts";
import { createAuth } from "../src/auth/auth";
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
  app: App;
  valkey: TestValkey;
  config: AppConfig;
  /** Epoch-ms clock used by the rate limiter; move it to cross window boundaries. */
  clock: { now: () => number; advance: (seconds: number) => void };
}

export interface SetupOptions {
  env?: Record<string, string>;
  /** Suffix of the dedicated `sob_test_<suffix>` database; defaults to `api`. */
  dbSuffix?: string;
  /** Extra application dependencies, for example a short SSE heartbeat. */
  deps?: Partial<
    Pick<AppDeps, "syncHeartbeatMs" | "jwksRefetchMs" | "emailProvider" | "paymentGateway">
  >;
}

export async function setupApiTest(options: SetupOptions = {}): Promise<ApiTest> {
  const t = await createTestDatabase(options.dbSuffix ?? "api");
  const valkey = await createTestValkey(options.dbSuffix ?? "api");
  const config = loadConfig({
    BETTER_AUTH_SECRET: TEST_SECRET,
    VALKEY_KEY_PREFIX: valkey.prefix,
    // Generous by default so only the rate-limit tests ever hit a limit.
    RATE_LIMIT_GLOBAL_MAX: "100000",
    RATE_LIMIT_AUTH_MAX: "100000",
    // Most suites sign clients up and book straight away; the verification suites opt in.
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
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
    // Tests truncate the database (and with it the signing keys) between cases.
    jwksRefetchMs: 0,
    ...options.deps,
  });
  const closeDb = t.close;
  const closeApp = () => app.shutdown();
  const resetDb = t.reset;
  const close = async () => {
    await closeApp();
    await closeDb();
    await valkey.close();
  };
  const reset = async () => {
    await resetDb();
    await valkey.clear();
    await app.ready();
  };
  await app.ready();
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

export interface Actor {
  userId: string;
  cookie: string;
  email: string;
  staffId: string | null;
  clientId: string | null;
}

/**
 * Creates an account with the given role and signs it in through the public endpoint.
 * For staff, `staffProfileId` re-links a fixture calendar (Ana, Bea) to the new login so
 * the staff member owns appointments that already exist in the fixtures.
 */
export async function actor(
  t: ApiTest,
  role: UserRole,
  email: string,
  options: { staffProfileId?: string } = {},
): Promise<Actor> {
  const auth = createAuth({ db: t.db, valkey: t.valkey.client, config: t.config });
  const created = await createAccount(
    { auth, db: t.db },
    { email, name: email.split("@")[0] ?? "Actor", password: PASSWORD, role },
  );
  let staffId = created.staffId;
  if (role === "staff" && options.staffProfileId) {
    if (created.staffId)
      await t.db.delete(staffProfile).where(eq(staffProfile.id, created.staffId));
    await t.db
      .update(staffProfile)
      .set({ userId: created.userId })
      .where(eq(staffProfile.id, options.staffProfileId));
    staffId = options.staffProfileId;
  }
  const { res, cookie } = await signIn(t.app, email);
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return { userId: created.userId, cookie, email, staffId, clientId: created.clientId };
}
