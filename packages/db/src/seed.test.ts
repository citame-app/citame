import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { salonSettings, service, serviceStaff, staffProfile, workingHours } from "./schema";
import { seedSampleData } from "./seed";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("db_seed");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function counts() {
  const n = async (table: PgTable) => (await t.db.select({ n: count() }).from(table))[0]?.n ?? 0;
  return {
    settings: await n(salonSettings),
    services: await n(service),
    staff: await n(staffProfile),
    links: await n(serviceStaff),
    hours: await n(workingHours),
  };
}

test("seeds generic sample data for the salon", async () => {
  await seedSampleData(t.db);
  const c = await counts();
  expect(c.settings).toBe(1);
  expect(c.services).toBe(6);
  expect(c.staff).toBe(2);
  expect(c.links).toBeGreaterThanOrEqual(6);
  expect(c.hours).toBeGreaterThanOrEqual(10);

  const [settings] = await t.db.select().from(salonSettings);
  expect(settings?.timezone).toBe("America/Argentina/Buenos_Aires");
  expect(settings?.name).toBe("Sisters of Beauty");
});

test("is idempotent: running twice changes nothing", async () => {
  await seedSampleData(t.db);
  const first = await counts();
  await seedSampleData(t.db);
  expect(await counts()).toEqual(first);
});

test("does not overwrite settings edited after the first seed", async () => {
  await seedSampleData(t.db);
  await t.db.update(salonSettings).set({ name: "Renamed Salon" }).where(eq(salonSettings.id, 1));
  await seedSampleData(t.db);
  const [settings] = await t.db.select().from(salonSettings);
  expect(settings?.name).toBe("Renamed Salon");
});
