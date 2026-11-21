import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { clientControlsSchema, DESKTOP_CLIENT_ID, DESKTOP_SIGN_IN_SCOPE } from "@sob/contracts";
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
import { ORIGIN, obtainTokens } from "../../../test/oauth";
import { pullAll } from "../../../test/sync";
import { desktopResource } from "../../oauth/desktop";

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

test("a linked Desktop updates the shared controls and the replica carries only its revision", async () => {
  const tokenFor = async (who: Actor) =>
    (
      await obtainTokens(t.app, {
        clientId: DESKTOP_CLIENT_ID,
        cookie: who.cookie,
        scope: `${DESKTOP_SIGN_IN_SCOPE} offline_access`,
        redirectUri: "http://127.0.0.1:63282/callback",
        resource: desktopResource(ORIGIN),
      })
    ).tokens.access_token;
  const [ownerToken, staffToken] = await Promise.all([tokenFor(owner), tokenFor(staff)]);
  const desktop = (token: string, method: string, body?: unknown) =>
    t.app.request(endpoint(), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const current = await desktop(ownerToken, "GET");
  const before = await pullAll(t, owner);
  expect(current.status).toBe(200);
  expect(current.headers.get("cache-control")).toBe("private, no-store");
  expect((await desktop(ownerToken, "DELETE")).status).toBe(403);
  const change = { version: 1, bookingAccess: "blocked", reason: "Private synthetic reason" };
  expect((await desktop(staffToken, "PATCH", change)).status).toBe(403);
  const saved = await desktop(ownerToken, "PATCH", { ...change, tags: [" VIP "] });
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toBe("private, no-store");
  expect(await (await call(owner, endpoint())).json()).toMatchObject({
    tags: ["vip"],
    bookingAccess: "blocked",
    version: 2,
  });
  expect((await desktop(staffToken, "PATCH", { version: 1, tags: ["stale"] })).status).toBe(409);
  const { changes } = await pullAll(t, owner);
  const contact = changes.find(
    (delta) => delta.entity === "client" && delta.op === "upsert" && delta.id === client.clientId,
  );
  expect(contact?.data).toMatchObject({ controlsVersion: 2 });
  const previousContact = before.changes.find(
    (delta) => delta.entity === "client" && delta.op === "upsert" && delta.id === client.clientId,
  );
  expect(contact?.data).toEqual({ ...previousContact?.data, controlsVersion: 2 });
  expect(contact?.data).not.toHaveProperty("tags");
  expect(JSON.stringify(contact)).not.toContain(change.reason);
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
