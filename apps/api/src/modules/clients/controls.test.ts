import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { clientControlsSchema } from "@sob/contracts";
import { appointment, staffProfile } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let staff: Actor;
let client: Actor;
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
const endpoint = () => `/admin/clients/${client.clientId}/controls`;
const monday = () => MONDAY_0900;
const book = () =>
  call(client, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: monday(),
  });
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "client_controls" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff, client] = await Promise.all([
    actor(t, "owner", "crm-owner@example.com"),
    actor(t, "staff", "crm-staff@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "crm-client@example.com"),
  ]);
});
test("profile controls default safely and customers cannot read internal controls", async () => {
  const response = await call(owner, endpoint());
  expect(response.status).toBe(200);
  expect(clientControlsSchema.parse(await response.json())).toMatchObject({
    tags: [],
    bookingAccess: "normal",
    reason: null,
    version: 1,
    canManageBookingAccess: true,
  });
  expect((await call(client, endpoint())).status).toBe(403);
});
test("professionals manage tags while only managers and owners may change booking access", async () => {
  const response = await call(staff, endpoint(), "PATCH", { version: 1, tags: [" VIP "] });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    tags: ["vip"],
    version: 2,
    canManageBookingAccess: false,
  });
  expect(
    (
      await call(staff, endpoint(), "PATCH", {
        version: 2,
        bookingAccess: "blocked",
        reason: "Abuse at last visit",
      })
    ).status,
  ).toBe(403);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, f.anaId));
  expect(
    (
      await call(staff, endpoint(), "PATCH", {
        version: 2,
        bookingAccess: "blocked",
        reason: "Documented account abuse",
      })
    ).status,
  ).toBe(200);
  expect((await call(owner, endpoint(), "PATCH", { version: 1, tags: ["stale"] })).status).toBe(
    409,
  );
});
test("blocking prevents new bookings without leaking the internal reason, and unblocking is reversible", async () => {
  const changed = await call(owner, endpoint(), "PATCH", {
    version: 1,
    bookingAccess: "blocked",
    reason: "Private internal incident",
  });
  expect(changed.status).toBe(200);
  const denied = await book();
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("Private internal incident");
  const [count] = await t.db.select().from(appointment);
  expect(count).toBeUndefined();
  expect(
    (
      await call(owner, endpoint(), "PATCH", {
        version: 2,
        bookingAccess: "normal",
        reason: "Account reviewed",
      })
    ).status,
  ).toBe(200);
  expect((await book()).status).toBe(201);
  const audit = await t.db.execute<{ metadata: unknown }>(
    sql`select metadata from audit_log where action='client.controls_updated'`,
  );
  expect(JSON.stringify(audit)).not.toContain("Private internal incident");
});
test("blocking keeps existing history but prevents moving an existing appointment", async () => {
  const booked = await book();
  expect(booked.status).toBe(201);
  const row = (await booked.json()) as { id: string; version: number };
  expect(
    (
      await call(owner, endpoint(), "PATCH", {
        version: 1,
        bookingAccess: "blocked",
        reason: "Review required",
      })
    ).status,
  ).toBe(200);
  const move = await call(client, `/appointments/${row.id}`, "PATCH", {
    version: row.version,
    startsAt: Temporal.Instant.from(monday()).add({ hours: 2 }).toString(),
  });
  expect(move.status).toBe(403);
  const [kept] = await t.db.select().from(appointment).where(eq(appointment.id, row.id));
  expect(kept?.status).toBe("booked");
  expect(
    (
      await call(client, `/appointments/${row.id}`, "PATCH", {
        version: row.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
});
test("trusted clients retain availability rules and tags can be searched literally", async () => {
  expect(
    (
      await call(owner, endpoint(), "PATCH", {
        version: 1,
        tags: ["vip%"],
        bookingAccess: "trusted",
        reason: "Regular client",
      })
    ).status,
  ).toBe(200);
  const list = await call(owner, "/admin/clients?search=vip%25");
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ total: 1 });
  const denied = await call(client, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: Temporal.Instant.from(monday()).add({ hours: 12 }).toString(),
  });
  expect(denied.status).toBe(409);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await call(staff, endpoint())).status).toBe(403);
});
test("legacy profile edits cannot clear a booking block or overwrite controls", async () => {
  expect(
    (
      await call(owner, endpoint(), "PATCH", {
        version: 1,
        tags: ["vip"],
        bookingAccess: "blocked",
        reason: "Contact required",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(staff, `/admin/clients/${client.clientId}`, "PATCH", {
        name: "Updated name",
        bookingAccess: "normal",
        tags: [],
        controlsVersion: 900,
      })
    ).status,
  ).toBe(200);
  const response = await call(owner, endpoint());
  expect(await response.json()).toMatchObject({
    bookingAccess: "blocked",
    tags: ["vip"],
    version: 2,
  });
  expect((await book()).status).toBe(403);
});
