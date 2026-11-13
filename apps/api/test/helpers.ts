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

export async function setupApiTest(): Promise<TestDatabase & { app: Hono }> {
  const t = await createTestDatabase("api");
  const app = createApp({ db: t.db, now: () => NOW });
  return Object.assign(t, { app });
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

export function json(app: Hono, path: string, method: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
