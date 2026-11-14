import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { errorResponseSchema, salonResponseSchema } from "@sob/contracts";
import { auditLog } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest();
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

const call = (who: Actor | null, method: string, body?: unknown) =>
  json(t.app, "/admin/settings", method, body, who?.cookie);
const code = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;

describe("access control", () => {
  test("anonymous is 401; staff and clients are 403 and nothing changes", async () => {
    expect((await call(null, "PATCH", { name: "x" })).status).toBe(401);
    for (const who of [ana, client]) {
      const res = await call(who, "PATCH", { name: "Hacked" });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
    }
    const salon = salonResponseSchema.parse(await (await json(t.app, "/salon", "GET")).json());
    expect(salon.name).toBe("Test Salon");
  });
});

describe("PATCH /admin/settings", () => {
  test("the owner edits settings; the public salon endpoint reflects it at once", async () => {
    const res = await call(owner, "PATCH", {
      name: "Studio Rosa",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
    });
    expect(res.status).toBe(200);
    const body = salonResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      name: "Studio Rosa",
      timezone: "America/Argentina/Buenos_Aires",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
    });
    const publicSalon = salonResponseSchema.parse(
      await (await json(t.app, "/salon", "GET")).json(),
    );
    expect(publicSalon).toEqual(body);
  });

  test("rejects invalid values with validation_error and changes nothing", async () => {
    for (const bad of [
      {},
      { timezone: "Mars/Olympus" },
      { slotGranularityMinutes: 7 },
      { maxDaysAhead: 0 },
    ]) {
      const res = await call(owner, "PATCH", bad);
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
      expect(await code(res)).toBe("validation_error");
    }
    expect(await (await call(owner, "GET")).json()).toMatchObject({ name: "Test Salon" });
  });

  test("audits changed field names only, and skips no-op edits", async () => {
    await call(owner, "PATCH", { name: "Studio Rosa", maxDaysAhead: 90 });
    await call(owner, "PATCH", { name: "Studio Rosa" }); // unchanged
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "settings.update"));
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toEqual({ fields: ["name"] });
  });

  test("the owner can read the settings", async () => {
    const res = await call(owner, "GET");
    expect(res.status).toBe(200);
    expect(salonResponseSchema.parse(await res.json()).name).toBe("Test Salon");
  });
});
