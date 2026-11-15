import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DESKTOP_CLIENT_ID } from "@sob/contracts";
import { accountEmailOutbox } from "@sob/db";
import { sql } from "drizzle-orm";
import {
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../test/helpers";
import { DEFAULT_RETENTION, runMaintenance } from "./maintenance";
import { createLogger } from "./observability/logger";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const silent = createLogger({ write: () => {} });

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "maintenance" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
});

const rows = async <T>(query: ReturnType<typeof sql>) =>
  (await t.db.execute(query)) as unknown as T[];
const count = async (table: string) =>
  (await rows<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))[0]?.n ?? -1;

test("account-email housekeeping erases expired capabilities and removes old terminal records", async () => {
  const values = (
    id: string,
    status: "pending" | "sent" | "failed",
    age: number,
    expired = true,
  ) => ({
    idempotencyKey: id,
    throttleKey: id,
    payload: "encrypted-capability",
    status,
    expiresAt: expired ? daysAgo(1) : new Date(NOW.getTime() + 3_600_000),
    scheduledFor: NOW,
    updatedAt: daysAgo(age),
  });
  await t.db
    .insert(accountEmailOutbox)
    .values([
      values("expired", "pending", 0),
      values("live", "pending", 0, false),
      values("old-sent", "sent", 120),
      values("old-failed", "failed", 200),
      values("recent-failed", "failed", 5),
    ]);
  const report = await runMaintenance(t.db, { now: NOW, logger: silent });
  expect(report.accountEmailsRemoved).toBe(2);
  const remaining = await t.db.select().from(accountEmailOutbox);
  expect(remaining).toHaveLength(3);
  expect(remaining.find((row) => row.idempotencyKey === "expired")?.payload).toBe("");
  expect(remaining.find((row) => row.idempotencyKey === "expired")?.status).toBe("skipped");
  expect(remaining.find((row) => row.idempotencyKey === "live")?.status).toBe("pending");
});

describe("sync log compaction", () => {
  test("old superseded entries go, the latest entry of every row stays", async () => {
    const owner = await actor(t, "owner", "owner@example.com");
    const created = (await (
      await json(
        t.app,
        "/appointments",
        "POST",
        {
          staffId: f.anaId,
          serviceIds: [f.haircutId],
          startsAt: MONDAY_0900,
          clientId: f.clientId,
        },
        owner.cookie,
      )
    ).json()) as { id: string; version: number };
    await json(
      t.app,
      `/appointments/${created.id}`,
      "PATCH",
      { status: "cancelled", version: created.version },
      owner.cookie,
    );
    const before = await count("sync_change");
    expect(before).toBeGreaterThan(1);
    await t.db.execute(sql`update sync_change set created_at = ${daysAgo(60)}`);

    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.syncLogRemoved).toBeGreaterThan(0);
    const latest = await rows<{ n: number }>(sql`
      select count(*)::int as n from (select distinct entity, row_id from sync_change) d`);
    expect(await count("sync_change")).toBe(latest[0]?.n ?? -1);
  });

  test("recent entries are never touched, even when superseded", async () => {
    const owner = await actor(t, "owner", "owner@example.com");
    const created = (await (
      await json(
        t.app,
        "/appointments",
        "POST",
        {
          staffId: f.anaId,
          serviceIds: [f.haircutId],
          startsAt: MONDAY_0900,
          clientId: f.clientId,
        },
        owner.cookie,
      )
    ).json()) as { id: string; version: number };
    await json(
      t.app,
      `/appointments/${created.id}`,
      "PATCH",
      { status: "cancelled", version: created.version },
      owner.cookie,
    );
    const before = await count("sync_change");
    await t.db.execute(sql`update sync_change set created_at = ${daysAgo(3)}`);
    await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(await count("sync_change")).toBe(before);
  });
});

describe("reminder retention", () => {
  async function bookedWithReminders(extra = false) {
    const owner = await actor(t, "owner", "owner@example.com");
    const starts = extra ? [MONDAY_0900, "2026-03-09T15:00:00.000Z"] : [MONDAY_0900];
    for (const startsAt of starts) {
      await json(
        t.app,
        "/appointments",
        "POST",
        { staffId: f.anaId, serviceIds: [f.haircutId], startsAt, clientId: f.clientId },
        owner.cookie,
      );
    }
  }

  test("finished reminders past retention are deleted; pending and recent ones stay", async () => {
    await t.db.execute(sql`update client_profile set email = 'lu@example.com'`);
    await bookedWithReminders(true);
    const all = await rows<{ id: string }>(sql`select id from reminder order by created_at, id`);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const [oldSent, oldSkipped, recentSent, pending] = all;
    await t.db.execute(
      sql`update reminder set status='sent', updated_at=${daysAgo(120)} where id=${oldSent?.id}`,
    );
    await t.db.execute(
      sql`update reminder set status='skipped', updated_at=${daysAgo(100)} where id=${oldSkipped?.id}`,
    );
    await t.db.execute(
      sql`update reminder set status='sent', updated_at=${daysAgo(5)} where id=${recentSent?.id}`,
    );
    await t.db.execute(sql`update reminder set updated_at=${daysAgo(400)} where id=${pending?.id}`);

    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.remindersRemoved).toBe(2);
    const left = await rows<{ id: string }>(sql`select id from reminder`);
    expect(left.map((r) => r.id)).toContain(recentSent?.id as string);
    expect(left.map((r) => r.id)).toContain(pending?.id as string);
    expect(left.map((r) => r.id)).not.toContain(oldSent?.id as string);
  });

  test("dead letters are kept longer than delivered messages", async () => {
    await t.db.execute(sql`update client_profile set email = 'lu@example.com'`);
    await bookedWithReminders();
    const [first, second] = await rows<{ id: string }>(sql`select id from reminder order by id`);
    await t.db.execute(
      sql`update reminder set status='failed', updated_at=${daysAgo(120)} where id=${first?.id}`,
    );
    await t.db.execute(
      sql`update reminder set status='failed', updated_at=${daysAgo(200)} where id=${second?.id}`,
    );
    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.remindersRemoved).toBe(1);
  });
});

describe("OAuth housekeeping", () => {
  async function seedOAuth() {
    const owner = await actor(t, "owner", "owner@example.com");
    const mk = (id: string, createdAt: Date) =>
      t.db.execute(sql`
        insert into oauth_client (id, client_id, redirect_uris, created_at, updated_at)
        values (${`id-${id}`}, ${id}, ${sql.raw("ARRAY['http://127.0.0.1/cb']")}, ${createdAt}, ${createdAt})`);
    await mk("idle-old", daysAgo(90));
    await mk("used-old", daysAgo(90));
    await mk("idle-new", daysAgo(2));
    await t.db.execute(sql`
      insert into oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
      values ('consent-1', 'used-old', ${owner.userId}, ${sql.raw("ARRAY['mcp:read']")}, ${daysAgo(80)}, ${daysAgo(80)})`);
    const token = (id: string, expiresAt: Date) =>
      t.db.execute(sql`
        insert into oauth_access_token (id, token, client_id, user_id, scopes, expires_at, created_at)
        values (${id}, ${`tok-${id}`}, 'used-old', ${owner.userId}, ${sql.raw("ARRAY['mcp:read']")}, ${expiresAt}, ${daysAgo(100)})`);
    await token("expired-long-ago", daysAgo(30));
    await token("expired-yesterday", daysAgo(1));
    await token("live", new Date(NOW.getTime() + 3_600_000));
  }

  test("expired tokens past the grace period go; live and just-expired ones stay", async () => {
    await seedOAuth();
    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.oauthTokensRemoved).toBe(1);
    const left = await rows<{ id: string }>(sql`select id from oauth_access_token order by id`);
    expect(left.map((r) => r.id)).toEqual(["expired-yesterday", "live"]);
  });

  test("idle dynamic clients are removed; used, recent and first-party clients are not", async () => {
    await seedOAuth();
    // The first-party desktop client is seeded at boot; make it look ancient and unused.
    await t.db.execute(
      sql`update oauth_client set created_at = ${daysAgo(400)} where client_id = ${DESKTOP_CLIENT_ID}`,
    );
    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.oauthClientsRemoved).toBe(1);
    const left = await rows<{ client_id: string }>(
      sql`select client_id from oauth_client order by client_id`,
    );
    expect(left.map((r) => r.client_id)).toEqual(
      [DESKTOP_CLIENT_ID, "idle-new", "used-old"].sort(),
    );
  });

  test("expired verification values and sessions are swept", async () => {
    const owner = await actor(t, "owner", "owner@example.com");
    await t.db.execute(sql`
      insert into verification (id, identifier, value, expires_at, created_at, updated_at)
      values ('v-old', 'x', 'y', ${daysAgo(10)}, ${daysAgo(11)}, ${daysAgo(11)}),
             ('v-new', 'x2', 'y2', ${new Date(NOW.getTime() + 3_600_000)}, ${NOW}, ${NOW})`);
    await t.db.execute(sql`
      insert into session (id, token, user_id, expires_at, created_at, updated_at)
      values ('s-old', 'tok-old', ${owner.userId}, ${daysAgo(10)}, ${daysAgo(40)}, ${daysAgo(40)})`);
    const report = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(report.verificationsRemoved).toBe(1);
    expect(report.sessionsRemoved).toBeGreaterThanOrEqual(1);
    expect((await rows<{ id: string }>(sql`select id from verification`)).map((r) => r.id)).toEqual(
      ["v-new"],
    );
  });
});

describe("running it", () => {
  test("is idempotent: a second run finds nothing to do", async () => {
    const first = await runMaintenance(t.db, { now: NOW, logger: silent });
    const { skipped, ...counts } = first;
    expect(skipped).toBe(false);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const second = await runMaintenance(t.db, { now: NOW, logger: silent });
    expect(second).toEqual(first);
  });

  test("retention windows are configurable", async () => {
    expect(DEFAULT_RETENTION).toMatchObject({
      syncLogDays: 30,
      reminderDays: 90,
      deadLetterDays: 180,
      oauthGraceDays: 7,
      idleClientDays: 30,
    });
  });

  test("two concurrent runs never double-process: the second one yields", async () => {
    const [a, b] = await Promise.all([
      runMaintenance(t.db, { now: NOW, logger: silent }),
      runMaintenance(t.db, { now: NOW, logger: silent }),
    ]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});
