import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { lockScheduling, type Tx } from "../../tx";
import { setServiceStaff } from "../services/admin";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "booking_catalog_race" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@booking-catalog-race.test");
});
const call = (path: string, method: string, body: unknown) =>
  json(t.app, path, method, body, owner.cookie);
/** Pause a writer after its advisory preflight reads, then change qualification before allocation. */
async function changeDuringPreflight(
  action: () => Promise<Response> | Response,
  staffIds: string[],
) {
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writer!: Tx;
  const configuration = t.db.transaction(async (tx) => {
    writer = tx;
    await lockScheduling(tx);
    ready();
    await resumed;
  });
  await held;
  const pending = Promise.resolve(action());
  try {
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await setServiceStaff(writer, f.haircutId, { staffIds }, { userId: owner.userId });
  } finally {
    release();
    await configuration;
  }
  return pending;
}
test("creating a visit rechecks a professional removed after its initial catalog read", async () => {
  const response = await changeDuringPreflight(
    () =>
      call("/appointments", "POST", {
        staffId: f.anaId,
        clientId: f.clientId,
        serviceIds: [f.haircutId],
        startsAt: "2026-03-09T12:00:00.000Z",
      }),
    [f.beaId],
  );
  expect(response.status, await response.clone().text()).toBe(400);
});
test("moving a visit cannot assign a professional whose qualification was removed during preflight", async () => {
  const created = await call("/appointments", "POST", {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
  });
  const booking = (await created.json()) as { id: string; version: number };
  const response = await changeDuringPreflight(
    () =>
      call(`/appointments/${booking.id}`, "PATCH", { version: booking.version, staffId: f.beaId }),
    [f.anaId],
  );
  expect(response.status, await response.clone().text()).toBe(400);
});
