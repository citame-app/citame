import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clientProfile, staffProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { errorCodeOf, pull, pullAll } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let bea: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "sync" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, bea, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

const call = (who: Actor | null, method: string, path: string, body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);

async function head() {
  return (await pull(t, owner, { since: 0, limit: 1 })).headSeq;
}

async function book(staffId = f.anaId, startsAt = MONDAY_0900) {
  const res = await call(owner, "POST", "/appointments", {
    staffId,
    serviceIds: [f.haircutId],
    startsAt,
    clientId: f.clientId,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; version: number };
}

describe("authorization", () => {
  test("anonymous callers get 401", async () => {
    const res = await call(null, "GET", "/sync/pull");
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
  });

  test("the client role is forbidden", async () => {
    const res = await call(client, "GET", "/sync/pull");
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("forbidden");
  });
});

describe("snapshot (since=0)", () => {
  test("returns every synced row once, validated against the contract", async () => {
    const { changes } = await pullAll(t, owner);
    const keys = changes.map((c) => `${c.entity}:${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const entities = new Set(changes.map((c) => c.entity));
    for (const entity of [
      "client",
      "service",
      "staff",
      "service_staff",
      "working_hours",
      "salon_settings",
    ]) {
      expect(entities.has(entity as never), entity).toBe(true);
    }
    expect(changes.find((c) => c.entity === "salon_settings")?.id).toBe("1");
    expect(changes.every((c) => c.op === "upsert" || c.data === null)).toBe(true);
  });

  test("an empty pull at the head returns the same cursor and no more pages", async () => {
    const h = await head();
    const page = await pull(t, owner, { since: h });
    expect(page).toEqual({ changes: [], nextCursor: h, hasMore: false, headSeq: h });
  });

  test("a cursor ahead of the server is refused so the client can resync", async () => {
    const h = await head();
    const res = await call(owner, "GET", `/sync/pull?since=${h + 1000}`);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("invalid_state");
  });

  test("validates query bounds", async () => {
    expect((await call(owner, "GET", "/sync/pull?limit=0")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?limit=100000")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?since=-1")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?since=abc")).status).toBe(400);
  });
});

describe("REST writes show up in pull", () => {
  test("booking and cancelling an appointment", async () => {
    const cursor = await head();
    const appt = await book();
    const created = await pull(t, owner, { since: cursor });
    expect(created.changes).toHaveLength(1);
    const change = created.changes[0];
    expect(change).toMatchObject({ entity: "appointment", id: appt.id, op: "upsert" });
    if (change?.entity !== "appointment" || change.op !== "upsert") throw new Error("unexpected");
    expect(change.data.status).toBe("booked");
    expect(change.data.services).toHaveLength(1);

    const cancelled = await call(owner, "PATCH", `/appointments/${appt.id}`, {
      version: appt.version,
      status: "cancelled",
    });
    expect(cancelled.status).toBe(200);
    const after = await pull(t, owner, { since: created.nextCursor });
    expect(after.changes).toHaveLength(1);
    const next = after.changes[0];
    if (next?.entity !== "appointment" || next.op !== "upsert") throw new Error("unexpected");
    expect(next.data.status).toBe("cancelled");
    expect(next.data.version).toBe(2);
  });

  test("a soft-deleted client is a tombstone", async () => {
    const [extra] = await t.db.insert(clientProfile).values({ name: "Temp" }).returning();
    if (!extra) throw new Error("insert failed");
    const cursor = await head();
    const res = await call(owner, "DELETE", `/admin/clients/${extra.id}`);
    expect(res.status).toBe(200);
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes).toEqual([
      { seq: expect.any(Number), entity: "client", id: extra.id, op: "delete", data: null },
    ]);
  });

  test("time off create then delete: upsert, then tombstone", async () => {
    const cursor = await head();
    const created = await call(owner, "POST", `/admin/staff/${f.anaId}/time-off`, {
      startsAt: "2026-03-12T12:00:00.000Z",
      endsAt: "2026-03-12T14:00:00.000Z",
    });
    expect(created.status).toBe(201);
    const { timeOff } = (await created.json()) as { timeOff: { id: string } };
    const first = await pull(t, owner, { since: cursor });
    expect(first.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
      ["time_off", timeOff.id, "upsert"],
    ]);

    await call(owner, "DELETE", `/admin/staff/${f.anaId}/time-off/${timeOff.id}`);
    const second = await pull(t, owner, { since: first.nextCursor });
    expect(second.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
      ["time_off", timeOff.id, "delete"],
    ]);
  });

  test("replacing working hours tombstones the old rows and announces the new ones", async () => {
    const cursor = await head();
    const res = await call(owner, "PUT", `/admin/staff/${f.anaId}/working-hours`, {
      hours: [{ weekday: 2, startTime: "10:00", endTime: "16:00" }],
    });
    expect(res.status).toBe(200);
    const page = await pull(t, owner, { since: cursor });
    const ops = page.changes
      .filter((c) => c.entity === "working_hours")
      .map((c) => c.op)
      .sort();
    expect(ops).toEqual(["delete", "upsert"]);
  });

  test("salon settings edits", async () => {
    const cursor = await head();
    await call(owner, "PATCH", "/admin/settings", { minNoticeMinutes: 15 });
    const page = await pull(t, owner, { since: cursor });
    const change = page.changes[0];
    expect(change?.entity).toBe("salon_settings");
    if (change?.entity !== "salon_settings" || change.op !== "upsert")
      throw new Error("unexpected");
    expect(change.data.minNoticeMinutes).toBe(15);
  });
});

describe("pagination and cursors", () => {
  test("pages are bounded, cursors never decrease and the union equals the full pull", async () => {
    for (let i = 0; i < 9; i++) await t.db.insert(clientProfile).values({ name: `Client ${i}` });
    const full = await pull(t, owner, { since: 0, limit: 500 });
    expect(full.hasMore).toBe(false);

    let cursor = 0;
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await pull(t, owner, { since: cursor, limit: 4 });
      pages++;
      expect(page.changes.length).toBeLessThanOrEqual(4);
      expect(page.nextCursor).toBeGreaterThanOrEqual(cursor);
      for (const c of page.changes) expect(c.seq).toBeLessThanOrEqual(page.nextCursor);
      seen.push(...page.changes.map((c) => `${c.entity}:${c.id}`));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(2);
    expect(cursor).toBe(full.nextCursor);
    expect(new Set(seen)).toEqual(new Set(full.changes.map((c) => `${c.entity}:${c.id}`)));
  });

  test("several writes to one row inside a page collapse into its latest entry", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "Edit me" }).returning();
    if (!row) throw new Error("insert failed");
    const cursor = await head();
    for (const name of ["one", "two", "three"]) {
      await t.db.update(clientProfile).set({ name }).where(eq(clientProfile.id, row.id));
    }
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes).toHaveLength(1);
    const change = page.changes[0];
    if (change?.entity !== "client" || change.op !== "upsert") throw new Error("unexpected");
    expect(change.data.name).toBe("three");
    expect(page.nextCursor).toBe(page.headSeq);
  });
});

describe("role filtering", () => {
  test("staff see their own appointments; other calendars arrive as tombstones", async () => {
    const mine = await book(f.anaId);
    const theirs = await book(f.beaId);
    const { changes } = await pullAll(t, ana);
    const appt = (id: string) => changes.find((c) => c.entity === "appointment" && c.id === id);
    expect(appt(mine.id)?.op).toBe("upsert");
    expect(appt(theirs.id)).toMatchObject({ op: "delete", data: null });
  });

  test("staff do not receive other calendars' schedules or login links", async () => {
    await call(owner, "POST", `/admin/staff/${f.beaId}/time-off`, {
      startsAt: "2026-03-12T12:00:00.000Z",
      endsAt: "2026-03-12T14:00:00.000Z",
    });
    const asAna = await pullAll(t, ana);
    const hours = asAna.changes.filter((c) => c.entity === "working_hours");
    for (const c of hours) {
      if (c.op === "upsert" && c.entity === "working_hours") expect(c.data.staffId).toBe(f.anaId);
    }
    expect(hours.some((c) => c.op === "delete")).toBe(true);
    expect(asAna.changes.find((c) => c.entity === "time_off")?.op).toBe("delete");

    const staffRows = asAna.changes.filter((c) => c.entity === "staff" && c.op === "upsert");
    for (const c of staffRows) {
      if (c.entity === "staff" && c.op === "upsert") expect(c.data.userId).toBeNull();
    }
    const asOwner = await pullAll(t, owner);
    const ownerStaff = asOwner.changes.find((c) => c.entity === "staff" && c.id === f.anaId);
    if (ownerStaff?.entity !== "staff" || ownerStaff.op !== "upsert") throw new Error("unexpected");
    expect(ownerStaff.data.userId).toBe(ana.userId);
  });

  test("an appointment moved to another calendar disappears for the old owner", async () => {
    const appt = await book(f.anaId);
    const cursor = (await pullAll(t, ana)).cursor;
    const moved = await call(owner, "PATCH", `/appointments/${appt.id}`, {
      version: appt.version,
      staffId: f.beaId,
    });
    expect(moved.status).toBe(200);
    const asAna = await pull(t, ana, { since: cursor });
    expect(asAna.changes).toEqual([
      { seq: expect.any(Number), entity: "appointment", id: appt.id, op: "delete", data: null },
    ]);
    const asBea = await pullAll(t, bea);
    expect(asBea.changes.find((c) => c.id === appt.id)?.op).toBe("upsert");
  });
});

test("fixtures stay referenced (guards the seeded staff profile link)", async () => {
  const [row] = await t.db.select().from(staffProfile).where(eq(staffProfile.id, f.anaId));
  expect(row?.userId).toBe(ana.userId);
});
