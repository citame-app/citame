import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointmentSchema,
  booksyContextReviewSchema,
  calendarResponseSchema,
} from "@sob/contracts";
import { appointment, appointmentContext, auditLog, checkout, serviceStaff } from "@sob/db";
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

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor, ana: Actor, bea: Actor, client: Actor;
beforeAll(async () => {
  t = await setupApiTest();
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
    actor(t, "client", "client@example.com"),
  ]);
});
const call = (path: string, method = "GET", body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
async function book(preference?: "any" | "specific", who = owner) {
  const res = await call(
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      clientId: who === client ? undefined : f.clientId,
      serviceIds: [f.haircutId, f.colorId],
      startsAt: MONDAY_0900,
      notes: "Booking comment",
      ...(preference ? { professionalPreference: preference } : {}),
    },
    who,
  );
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}
const calendar = async () =>
  calendarResponseSchema.parse(
    await (
      await call("/appointments/calendar?from=2026-03-09T03:00:00Z&to=2026-03-16T03:00:00Z")
    ).json(),
  );
test("preference is explicit, service scoped, private notes never enter public DTO or sync", async () => {
  const visit = await book("specific", client);
  let c = await calendar();
  expect(c.appointments[0]?.serviceBadges?.every((b) => b.requested && b.customerComment)).toBe(
    true,
  );
  const res = await call(`/appointments/${visit.id}/context`, "PATCH", {
    appointmentVersion: visit.version,
    servicePosition: 1,
    version: 0,
    requested: false,
    internalNote: "PRIVATE STAFF ONLY",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  c = await calendar();
  expect(c.appointments[0]?.serviceBadges).toMatchObject([
    { servicePosition: 0, requested: true, internalNote: false },
    { servicePosition: 1, requested: false, internalNote: true },
  ]);
  expect(JSON.stringify(c)).not.toContain("PRIVATE STAFF ONLY");
  expect(await (await call("/appointments", "GET", undefined, client)).text()).not.toContain(
    "PRIVATE STAFF ONLY",
  );
  expect(await (await call("/sync/pull?since=0&limit=200")).text()).not.toContain(
    "PRIVATE STAFF ONLY",
  );
  expect((await call(`/appointments/${visit.id}/context`, "GET", undefined, client)).status).toBe(
    403,
  );
  expect((await call(`/appointments/${visit.id}/context`, "GET", undefined, bea)).status).toBe(404);
  const allowed = await call(`/appointments/${visit.id}/context`, "GET", undefined, ana);
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  expect(await allowed.json()).toMatchObject({
    appointmentVersion: visit.version + 1,
    canEdit: true,
    defaultRequested: true,
    rows: [{ servicePosition: 1, version: 1, internalNote: "PRIVATE STAFF ONLY" }],
  });
});
test("automatic assignment and legacy appointments never imply a requested professional", async () => {
  await book("any");
  expect((await calendar()).appointments[0]?.serviceBadges?.some((b) => b.requested)).toBe(false);
});
test("a business message is visible in private appointment context and excluded from sync", async () => {
  const visit = await book("specific", client);
  const message = "Original message from the centre";
  const visitGroupId = Bun.randomUUIDv7();
  await t.db
    .update(appointment)
    .set({ sourceBusinessMessage: message, visitGroupId })
    .where(eq(appointment.id, visit.id));
  const details = await call(`/appointments/${visit.id}/context`, "GET", undefined, ana);
  expect(await details.json()).toMatchObject({
    businessMessage: message,
    customerComment: "Booking comment",
  });
  expect((await call(`/appointments/${visit.id}/context`, "GET", undefined, bea)).status).toBe(404);
  expect((await call(`/appointments/${visit.id}/context`, "GET", undefined, client)).status).toBe(
    403,
  );
  const calendarItem = (await calendar()).appointments.find(({ id }) => id === visit.id);
  expect(calendarItem?.visitGroupId).toBe(visitGroupId);
  expect(JSON.stringify(calendarItem)).not.toContain(message);
  const sync = await (await call("/sync/pull?since=0&limit=200")).text();
  expect(sync).toContain(visitGroupId);
  expect(sync).not.toContain(message);
});

test("reviewed import is idempotent, preserves source notes and never manufactures payment revenue", async () => {
  const visit = await book();
  const input = {
    rows: [
      {
        appointmentId: visit.id,
        appointmentVersion: visit.version,
        contextVersion: 0,
        servicePosition: 1,
        requestedStaffId: f.anaId,
        internalNote: "Private imported",
        customerComment: "Customer imported",
        invoiced: true,
        paid: false,
        sourceRef: "synthetic-booksy-service-2",
      },
    ],
  };
  const preview = await call("/appointments/booksy-context/preview", "POST", input);
  expect(preview.status).toBe(200);
  const review = booksyContextReviewSchema.parse(await preview.json());
  expect(review).toMatchObject({
    appointments: 1,
    services: 1,
    internalNotes: 1,
    customerComments: 1,
    invoiced: 1,
    paid: 0,
  });
  expect(
    (
      await call("/appointments/booksy-context/import", "POST", {
        input,
        reviewHash: review.reviewHash,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/appointments/booksy-context/import", "POST", {
        input,
        reviewHash: review.reviewHash,
      })
    ).status,
  ).toBe(200);
  const rows = await t.db.select().from(appointmentContext);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.version).toBe(1);
  const [changed] = await t.db.select().from(appointment).where(eq(appointment.id, visit.id));
  expect(changed?.version).toBe(2);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
  const badges = (await calendar()).appointments[0]?.serviceBadges;
  expect(badges?.[0]?.invoiced).toBe(false);
  expect(badges?.[1]).toMatchObject({
    requested: true,
    invoiced: true,
    paid: false,
    billingSource: "booksy",
    internalNote: true,
    customerComment: true,
  });
  const audits = await t.db.select().from(auditLog);
  expect(JSON.stringify(audits)).not.toContain("Private imported");
  const changedInput = { rows: [{ ...input.rows[0]!, paid: true }] };
  expect(
    (
      await call("/appointments/booksy-context/import", "POST", {
        input: changedInput,
        reviewHash: review.reviewHash,
      })
    ).status,
  ).toBe(400);
});
test("stale imports and annotation edits fail atomically; only owners import future records", async () => {
  const visit = await book();
  const row = {
    appointmentId: visit.id,
    appointmentVersion: visit.version,
    contextVersion: 0,
    servicePosition: 0,
    requestedStaffId: null,
    internalNote: null,
    customerComment: null,
    invoiced: null,
    paid: null,
    sourceRef: "synthetic-source",
  };
  const input = { rows: [row] };
  const review = booksyContextReviewSchema.parse(
    await (await call("/appointments/booksy-context/preview", "POST", input)).json(),
  );
  expect((await call("/appointments/booksy-context/preview", "POST", input, ana)).status).toBe(403);
  await call(`/appointments/${visit.id}`, "PATCH", {
    version: visit.version,
    notes: "Newer comment",
  });
  expect(
    (
      await call("/appointments/booksy-context/import", "POST", {
        input,
        reviewHash: review.reviewHash,
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointmentContext)).toHaveLength(0);
  expect(
    (
      await call(`/appointments/${visit.id}/context`, "PATCH", {
        appointmentVersion: visit.version,
        version: 0,
        servicePosition: 0,
        requested: true,
        internalNote: "Stale",
      })
    ).status,
  ).toBe(409);
  await t.db
    .update(appointment)
    .set({ startsAt: new Date("2026-03-01T12:00:00Z"), endsAt: new Date("2026-03-01T13:00:00Z") })
    .where(eq(appointment.id, visit.id));
  expect(
    (
      await call("/appointments/booksy-context/preview", "POST", {
        rows: [{ ...row, appointmentVersion: 2 }],
      })
    ).status,
  ).toBe(400);
});

test("editing a private note preserves the original requested professional after reassignment", async () => {
  const visit = await book();
  await t.db.insert(serviceStaff).values({ serviceId: f.colorId, staffId: f.beaId });
  await t.db.insert(appointmentContext).values({
    appointmentId: visit.id,
    servicePosition: 0,
    requestedStaffId: f.anaId,
    internalNote: "Original private note",
    source: "booksy",
    sourceRef: "synthetic-preference-before-move",
  });
  const moved = await call(`/appointments/${visit.id}`, "PATCH", {
    version: visit.version,
    startsAt: visit.startsAt,
    staffId: f.beaId,
  });
  expect(moved.status).toBe(200);
  const reassigned = appointmentSchema.parse(await moved.json());
  const saved = await call(`/appointments/${visit.id}/context`, "PATCH", {
    appointmentVersion: reassigned.version,
    servicePosition: 0,
    version: 1,
    internalNote: "Updated private note",
  });
  expect(saved.status).toBe(200);
  const [context] = await t.db.select().from(appointmentContext);
  expect(context?.requestedStaffId).toBe(f.anaId);
  expect(context?.sourceRef).toBe("synthetic-preference-before-move");
  const calendarVisit = (await calendar()).appointments.find(({ id }) => id === visit.id);
  expect(calendarVisit?.serviceBadges?.[0]).toMatchObject({ requested: true });
  const [unchanged] = await t.db.select().from(appointment).where(eq(appointment.id, visit.id));
  expect(unchanged?.staffId).toBe(f.beaId);
  expect(unchanged?.startsAt.toISOString()).toBe(visit.startsAt);
  expect(unchanged?.status).toBe(visit.status);
  const input = {
    rows: [
      {
        appointmentId: visit.id,
        appointmentVersion: reassigned.version + 1,
        contextVersion: 0,
        servicePosition: 1,
        requestedStaffId: null,
        internalNote: null,
        customerComment: null,
        invoiced: null,
        paid: null,
        sourceRef: "synthetic-preference-before-move",
      },
    ],
  };
  expect((await call("/appointments/booksy-context/preview", "POST", input)).status).toBe(409);
  expect(await t.db.select().from(appointmentContext)).toHaveLength(1);
});
