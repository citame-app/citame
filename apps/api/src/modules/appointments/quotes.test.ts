import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, service } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

import { lockScheduling, type Tx } from "../../tx";
import { updateService } from "../services/admin";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
const call = (path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, owner.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "booking_quotes" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@booking-quotes.test");
});
const book = (serviceQuotes?: Record<string, string>) =>
  call("/appointments", "POST", {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    ...(serviceQuotes ? { serviceQuotes } : {}),
  });
async function quote() {
  const list = (await (await call("/services")).json()) as {
    services: { id: string; quoteHash?: string }[];
  };
  const selected = list.services.find((s) => s.id === f.haircutId);
  expect(selected?.quoteHash).toMatch(/^[a-f0-9]{64}$/);
  if (!selected?.quoteHash) throw new Error("Missing quote");
  return selected.quoteHash;
}
test("a stale reviewed price cannot silently create a differently priced visit", async () => {
  const original = await quote();
  expect(
    (await call(`/admin/services/${f.haircutId}`, "PATCH", { priceCents: 12000 })).status,
  ).toBe(200);
  const r = await book({ [f.haircutId]: original });
  expect(r.status, await r.clone().text()).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const updated = await quote();
  expect(updated).not.toBe(original);
  expect((await book({ [f.haircutId]: updated })).status).toBe(201);
});
test("quote identity binds duration and cleanup even when the price and administrative revision are unchanged", async () => {
  const original = await quote();
  await t.db
    .update(service)
    .set({ durationMinutes: 60, bufferMinutes: 30 })
    .where(eq(service.id, f.haircutId));
  expect((await book({ [f.haircutId]: original })).status).toBe(409);
  const updated = await quote();
  const r = await book({ [f.haircutId]: updated });
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ endsAt: "2026-03-09T13:30:00.000Z" });
});
test("a partial or unrelated quote map is rejected while compatibility clients may omit the optional quote fence", async () => {
  const hash = await quote();
  expect((await book({ [f.colorId]: hash })).status).toBe(409);
  expect((await book({ [f.haircutId]: hash, [f.colorId]: hash })).status).toBe(409);
  expect((await book()).status).toBe(201);
});

test("the quote is checked again after waiting for a concurrent catalog writer", async () => {
  const original = await quote();
  let release!: () => void;
  let ready!: () => void;
  let writer!: Tx;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configuration = t.db.transaction(async (tx) => {
    writer = tx;
    await lockScheduling(tx);
    ready();
    await resume;
  });
  await held;
  const pending = Promise.resolve(book({ [f.haircutId]: original }));
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
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
    await updateService(writer, f.haircutId, { priceCents: 15000 }, { userId: owner.userId });
  } finally {
    release();
    await configuration;
  }
  expect((await pending).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
