import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  errorResponseSchema,
  notificationPreferencesSchema,
  notificationStatsSchema,
  optOutPreviewSchema,
  ownerSalonSettingsSchema,
} from "@sob/contracts";
import { accountEmailOutbox, auditLog, clientProfile, notificationPreference } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";
import { createAppointment } from "../modules/appointments/service";
import { signOptOutToken } from "./tokens";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "notify_routes" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

const code = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;
const prefs = (who: Actor | null, method = "GET", body?: unknown) =>
  json(t.app, "/me/notification-preferences", method, body, who?.cookie);
const token = (clientId = client.clientId ?? "") =>
  signOptOutToken(t.config.notifications.signingSecret, { clientId, channel: "email" });

describe("GET/PATCH /me/notification-preferences", () => {
  test("requires a session and a booking profile", async () => {
    expect((await prefs(null)).status).toBe(401);
    expect((await prefs(owner)).status).toBe(403);
  });

  test("returns the defaults: email on, SMS off, no locale", async () => {
    const res = await prefs(client);
    expect(res.status).toBe(200);
    expect(notificationPreferencesSchema.parse(await res.json())).toEqual({
      locale: null,
      email: { transactional: true, reminder: true },
      sms: { transactional: false, reminder: false },
      whatsapp: { transactional: false, reminder: false },
      hasWhatsAppPhone: false,
      hasEmail: true,
      hasPhone: false,
    });
  });

  test("stores per-channel choices and the locale, and audits the change", async () => {
    const res = await prefs(client, "PATCH", {
      locale: "es-AR",
      email: { reminder: false },
      sms: { transactional: true, reminder: true },
    });
    expect(res.status).toBe(200);
    const body = notificationPreferencesSchema.parse(await res.json());
    expect(body.locale).toBe("es-AR");
    expect(body.email).toEqual({ transactional: true, reminder: false });
    expect(body.sms).toEqual({ transactional: true, reminder: true });
    const [row] = await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, client.clientId ?? ""));
    expect(row?.locale).toBe("es-AR");
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "notifications.preferences"));
    expect(audits).toHaveLength(1);
    // A second identical write is idempotent.
    await prefs(client, "PATCH", { email: { reminder: false } });
    expect(await t.db.select().from(notificationPreference)).toHaveLength(3);
  });

  test("rejects an unknown locale and an empty change", async () => {
    expect(await code(await prefs(client, "PATCH", { locale: "fr" }))).toBe("validation_error");
    expect(await code(await prefs(client, "PATCH", {}))).toBe("validation_error");
  });

  test("one client cannot read or change another's preferences", async () => {
    const other = await actor(t, "client", "other@example.com");
    await prefs(client, "PATCH", { email: { reminder: false } });
    const res = await prefs(other);
    expect(notificationPreferencesSchema.parse(await res.json()).email.reminder).toBe(true);
  });
});

describe("opt-out link", () => {
  test("GET previews without changing anything (mail scanners prefetch links)", async () => {
    const res = await json(t.app, `/notifications/opt-out?token=${token()}`, "GET");
    expect(res.status).toBe(200);
    expect(optOutPreviewSchema.parse(await res.json())).toEqual({
      channel: "email",
      category: "reminder",
      optedOut: false,
    });
    expect(await t.db.select().from(notificationPreference)).toHaveLength(0);
  });

  test("POST switches email reminders off without a login, and only reminders", async () => {
    const res = await json(t.app, "/notifications/opt-out", "POST", { token: token() });
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(notificationPreference);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "email", category: "reminder", enabled: false });
    const preview = await json(t.app, `/notifications/opt-out?token=${token()}`, "GET");
    expect(optOutPreviewSchema.parse(await preview.json()).optedOut).toBe(true);
  });

  test("POST also accepts the token in the query string (RFC 8058 one-click)", async () => {
    const res = await t.app.request(`/notifications/opt-out?token=${token()}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:3000",
      },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await t.db.select().from(notificationPreference)).toHaveLength(1);
  });

  test("is idempotent and audited without a user", async () => {
    await json(t.app, "/notifications/opt-out", "POST", { token: token() });
    await json(t.app, "/notifications/opt-out", "POST", { token: token() });
    expect(await t.db.select().from(notificationPreference)).toHaveLength(1);
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "notifications.opt_out"));
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.entityId).toBe(client.clientId ?? "");
  });

  test("rejects forged, truncated and unknown-client tokens", async () => {
    for (const bad of ["garbage", `${token()}x`, token("0190aaaa-0000-7000-8000-000000000099")]) {
      const post = await json(t.app, "/notifications/opt-out", "POST", { token: bad });
      expect(post.status).toBeGreaterThanOrEqual(400);
      const get = await json(
        t.app,
        `/notifications/opt-out?token=${encodeURIComponent(bad)}`,
        "GET",
      );
      expect(get.status).toBeGreaterThanOrEqual(400);
    }
    expect(await t.db.select().from(notificationPreference)).toHaveLength(0);
  });
});

describe("owner settings: reminder lead times", () => {
  const call = (who: Actor | null, method: string, body?: unknown) =>
    json(t.app, "/admin/settings", method, body, who?.cookie);

  test("GET exposes the defaults to the owner", async () => {
    const res = await call(owner, "GET");
    expect(ownerSalonSettingsSchema.parse(await res.json())).toMatchObject({
      reminderFirstLeadMinutes: 1440,
      reminderSecondLeadMinutes: 120,
    });
  });

  test("PATCH changes, disables and audits; the public salon endpoint stays unchanged", async () => {
    const res = await call(owner, "PATCH", {
      reminderFirstLeadMinutes: null,
      reminderSecondLeadMinutes: 180,
    });
    expect(res.status).toBe(200);
    expect(ownerSalonSettingsSchema.parse(await res.json())).toMatchObject({
      reminderFirstLeadMinutes: null,
      reminderSecondLeadMinutes: 180,
    });
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.update"));
    expect(audit?.metadata).toEqual({
      fields: ["reminderFirstLeadMinutes", "reminderSecondLeadMinutes"],
    });
    const salon = await json(t.app, "/salon", "GET");
    expect(Object.keys((await salon.json()) as object)).not.toContain("reminderFirstLeadMinutes");
  });

  test("rejects absurd lead times and non-owners", async () => {
    expect((await call(owner, "PATCH", { reminderSecondLeadMinutes: 1 })).status).toBe(400);
    expect((await call(owner, "PATCH", { reminderFirstLeadMinutes: 0 })).status).toBe(400);
    expect((await call(ana, "PATCH", { reminderFirstLeadMinutes: 60 })).status).toBe(403);
  });
});

describe("GET /admin/notifications/stats", () => {
  test("is owner-only and reports queue depth by status", async () => {
    await t.db.insert(accountEmailOutbox).values({
      idempotencyKey: "stats",
      throttleKey: "stats",
      payload: "opaque",
      scheduledFor: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    await t.db
      .update(clientProfile)
      .set({ email: "c@example.com" })
      .where(eq(clientProfile.id, f.clientId));
    await createAppointment(
      t.db,
      { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900, clientId: f.clientId },
      { userId: owner.userId },
      { now: NOW },
    );
    expect(
      (await json(t.app, "/admin/notifications/stats", "GET", undefined, ana.cookie)).status,
    ).toBe(403);
    const res = await json(t.app, "/admin/notifications/stats", "GET", undefined, owner.cookie);
    expect(res.status).toBe(200);
    const body = notificationStatsSchema.parse(await res.json());
    expect(body.queue.pending).toBe(3);
    expect(body.accountEmails.pending).toBe(1);
    expect(body.channels).toEqual({ email: false, sms: false });
    expect(body.worker).toHaveProperty("sent");
  });
});
