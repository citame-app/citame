import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  adminServiceSchema,
  errorResponseSchema,
  listAdminServicesResponseSchema,
  listServicesResponseSchema,
  reviewedServiceListSchema,
} from "@sob/contracts";
import { auditLog, serviceStaff } from "@sob/db";
import { and, asc, eq } from "drizzle-orm";
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

const call = (who: Actor | null, method: string, path: string, body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const errorCode = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;
const audit = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));

const newService = { name: "Blow dry", durationMinutes: 30, bufferMinutes: 5, priceCents: 8000 };

test("reviewed service edits reject stale versions and restored histories", async () => {
  const response = await call(owner, "GET", "/admin/services/reviewed");
  expect(response.status).toBe(200);
  const { generation, services } = reviewedServiceListSchema.parse(await response.json());
  const existing = services.find(({ id }) => id === f.haircutId);
  if (!existing?.version) throw new Error("Missing reviewed catalogue fixture");
  const route = `/admin/services/${existing.id}/reviewed`;
  const change = { generation, version: existing.version, service: { priceCents: 3200 } };
  expect((await call(ana, "PUT", route, change)).status).toBe(403);
  expect(await errorCode(await call(owner, "PUT", route, { ...change, generation: "old" }))).toBe(
    "sync_generation_changed",
  );
  const saved = await call(owner, "PUT", route, change);
  expect(saved.status).toBe(200);
  expect(adminServiceSchema.parse(await saved.json())).toMatchObject({
    priceCents: 3200,
    version: existing.version + 1,
    staffIds: existing.staffIds,
  });
  expect(
    await errorCode(await call(owner, "PUT", route, { ...change, service: { priceCents: 100 } })),
  ).toBe("version_conflict");
});

describe("catalog organisation and online visibility", () => {
  test("a visit cannot add amounts expressed in different currencies", async () => {
    const other = adminServiceSchema.parse(
      await (
        await call(owner, "POST", "/admin/services", {
          ...newService,
          currency: "EUR",
          staffIds: [f.anaId],
        })
      ).json(),
    );
    expect(
      (
        await call(client, "POST", "/appointments", {
          staffId: f.anaId,
          serviceIds: [f.haircutId, other.id],
          startsAt: MONDAY_0900,
        })
      ).status,
    ).toBe(400);
  });
  test("a service can control its public starting interval, enforced on direct customer submissions", async () => {
    const created = adminServiceSchema.parse(
      await (
        await call(owner, "POST", "/admin/services", {
          ...newService,
          durationMinutes: 30,
          bufferMinutes: 0,
          bookingIntervalMinutes: 60,
          staffIds: [f.anaId],
        })
      ).json(),
    );
    expect(created).toMatchObject({ bookingIntervalMinutes: 60 });
    const slots = (await (
      await call(
        null,
        "GET",
        `/availability?date=2026-03-09&serviceIds=${created.id}&staffId=${f.anaId}`,
      )
    ).json()) as { slots: { startsAt: string }[] };
    expect(slots.slots.some((s) => s.startsAt === "2026-03-09T12:30:00.000Z")).toBe(false);
    expect(slots.slots.some((s) => s.startsAt === MONDAY_0900)).toBe(true);
    expect(
      (
        await call(client, "POST", "/appointments", {
          staffId: f.anaId,
          serviceIds: [created.id],
          startsAt: "2026-03-09T12:30:00.000Z",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(client, "POST", "/appointments", {
          staffId: f.anaId,
          serviceIds: [created.id],
          startsAt: MONDAY_0900,
        })
      ).status,
    ).toBe(201);
  });
  test("processing and duration are reviewed and saved together without an intermediate invalid treatment", async () => {
    const res = await call(owner, "POST", "/admin/services", {
      ...newService,
      durationMinutes: 90,
      processing: { startsAfterMinutes: 30, minutes: 30 },
    });
    const created = adminServiceSchema.parse(await res.json());
    expect(created.processing).toEqual({ startsAfterMinutes: 30, minutes: 30 });
    const invalid = await call(owner, "PUT", `/admin/services/${created.id}/configuration`, {
      version: created.version,
      staffIds: [],
      service: { durationMinutes: 45, category: "Invalid" },
    });
    expect(invalid.status).toBe(400);
    const valid = await call(owner, "PUT", `/admin/services/${created.id}/configuration`, {
      version: created.version,
      staffIds: [],
      service: { durationMinutes: 45, processing: null, category: "Hair" },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ durationMinutes: 45, category: "Hair" });
  });
  test("saves reviewed category, order and instructions; internal services stay bookable by the team", async () => {
    const res = await call(owner, "POST", "/admin/services", {
      ...newService,
      category: "  Hair  ",
      sortOrder: 2,
      onlineBooking: false,
      clientInstructions: "Arrive with dry hair",
      staffIds: [f.anaId],
    });
    expect(res.status).toBe(201);
    const created = adminServiceSchema.parse(await res.json());
    expect(created).toMatchObject({
      category: "Hair",
      sortOrder: 2,
      onlineBooking: false,
      clientInstructions: "Arrive with dry hair",
    });
    const publicList = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(publicList.services.map((s: { id: string }) => s.id)).not.toContain(created.id);
    const direct = await call(client, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [created.id],
      startsAt: MONDAY_0900,
    });
    expect(direct.status).toBe(403);
    const delegated = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [created.id],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    expect(delegated.status).toBe(201);
  });

  test("category changes use the editor revision fence and preserve the unsaved newer record", async () => {
    const current = listAdminServicesResponseSchema
      .parse(await (await call(owner, "GET", "/admin/services")).json())
      .services.find((s: { id: string }) => s.id === f.haircutId);
    if (!current) throw new Error("Missing fixture service");
    const body = {
      version: current.version,
      staffIds: current.staffIds,
      service: { category: "Hair", sortOrder: 3, onlineBooking: true },
    };
    expect(
      (await call(owner, "PUT", `/admin/services/${f.haircutId}/configuration`, body)).status,
    ).toBe(200);
    expect(
      (
        await call(owner, "PUT", `/admin/services/${f.haircutId}/configuration`, {
          ...body,
          service: { category: "Stale" },
        })
      ).status,
    ).toBe(409);
    const list = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(list.services.find((s: { id: string }) => s.id === f.haircutId)).toMatchObject({
      category: "Hair",
      sortOrder: 3,
    });
  });

  test("rejects empty categories and negative display order", async () => {
    for (const fields of [{ category: "   " }, { category: "x".repeat(101) }, { sortOrder: -1 }]) {
      expect(
        (await call(owner, "POST", "/admin/services", { ...newService, ...fields })).status,
      ).toBe(400);
    }
  });
});

describe("access control", () => {
  const cases: [string, string, unknown][] = [
    ["GET", "/admin/services", undefined],
    ["POST", "/admin/services", newService],
    ["PATCH", "/admin/services/{id}", { name: "x" }],
    ["DELETE", "/admin/services/{id}", undefined],
    ["PUT", "/admin/services/{id}/staff", { staffIds: [] }],
  ];

  test("anonymous callers get 401", async () => {
    for (const [method, path, body] of cases) {
      const res = await call(null, method, path.replace("{id}", f.haircutId), body);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  test("staff and clients get 403 and nothing changes", async () => {
    for (const who of [ana, client]) {
      for (const [method, path, body] of cases) {
        const res = await call(who, method, path.replace("{id}", f.haircutId), body);
        expect([method, path, res.status]).toEqual([method, path, 403]);
        expect(await errorCode(res)).toBe("forbidden");
      }
    }
    expect((await audit("service.create")).length).toBe(0);
    const services = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(services.services.map((s) => s.name).sort()).toEqual(["Color", "Haircut"]);
  });
});

describe("GET /admin/services", () => {
  test("lists every service, inactive ones included, with who performs it", async () => {
    await call(owner, "DELETE", `/admin/services/${f.colorId}`);
    const res = await call(owner, "GET", "/admin/services");
    expect(res.status).toBe(200);
    const { services } = listAdminServicesResponseSchema.parse(await res.json());
    const byName = Object.fromEntries(services.map((s) => [s.name, s]));
    expect(byName.Haircut?.active).toBe(true);
    expect(byName.Haircut?.staffIds.sort()).toEqual([f.anaId, f.beaId].sort());
    expect(byName.Color?.active).toBe(false);
  });
});

describe("POST /admin/services", () => {
  test("creates an active service that shows up in the public catalog, and audits it", async () => {
    const res = await call(owner, "POST", "/admin/services", {
      ...newService,
      description: "Wash and dry",
    });
    expect(res.status).toBe(201);
    const created = adminServiceSchema.parse(await res.json());
    expect(created).toMatchObject({
      name: "Blow dry",
      description: "Wash and dry",
      currency: "ARS",
      active: true,
      staffIds: [],
    });

    const publicList = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(publicList.services.map((s) => s.id)).toContain(created.id);

    const [row] = await audit("service.create");
    expect(row).toMatchObject({
      actorUserId: owner.userId,
      entity: "service",
      entityId: created.id,
    });
  });

  test("defaults the buffer to zero", async () => {
    const { bufferMinutes: _b, ...noBuffer } = newService;
    const res = await call(owner, "POST", "/admin/services", noBuffer);
    expect(adminServiceSchema.parse(await res.json()).bufferMinutes).toBe(0);
  });

  test("rejects invalid bodies with 400 validation_error", async () => {
    const res = await call(owner, "POST", "/admin/services", { ...newService, durationMinutes: 0 });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });
});

describe("PATCH /admin/services/:id", () => {
  test("updates fields without touching history: booked snapshots keep the old price", async () => {
    const booked = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    expect(booked.status).toBe(201);

    const res = await call(owner, "PATCH", `/admin/services/${f.haircutId}`, {
      priceCents: 99999,
      name: "Haircut Deluxe",
    });
    expect(res.status).toBe(200);
    expect(adminServiceSchema.parse(await res.json())).toMatchObject({
      priceCents: 99999,
      name: "Haircut Deluxe",
    });

    const listed = await call(
      owner,
      "GET",
      "/appointments?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
    );
    const body = (await listed.json()) as {
      appointments: { services: { name: string; priceCents: number }[] }[];
    };
    expect(body.appointments[0]?.services[0]).toMatchObject({ name: "Haircut", priceCents: 10000 });

    const [row] = await audit("service.update");
    expect(row?.entityId).toBe(f.haircutId);
    expect(row?.metadata).toMatchObject({ changed: ["name", "priceCents"] });
  });

  test("active false hides it from the public catalog and active true restores it", async () => {
    const off = await call(owner, "PATCH", `/admin/services/${f.haircutId}`, { active: false });
    expect(adminServiceSchema.parse(await off.json()).active).toBe(false);
    const hidden = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(hidden.services.map((s) => s.name)).toEqual(["Color"]);
    expect((await audit("service.deactivate")).length).toBe(1);

    await call(owner, "PATCH", `/admin/services/${f.haircutId}`, { active: true });
    const shown = listServicesResponseSchema.parse(
      await (await call(null, "GET", "/services")).json(),
    );
    expect(shown.services).toHaveLength(2);
    expect((await audit("service.activate")).length).toBe(1);
  });

  test("404 for an unknown service, 400 for an empty or invalid body", async () => {
    const unknown = await call(owner, "PATCH", `/admin/services/${Bun.randomUUIDv7()}`, {
      name: "x",
    });
    expect(unknown.status).toBe(404);
    const empty = await call(owner, "PATCH", `/admin/services/${f.haircutId}`, {});
    expect(empty.status).toBe(400);
    const badId = await call(owner, "PATCH", "/admin/services/not-a-uuid", { name: "x" });
    expect(badId.status).toBe(400);
  });
});

describe("DELETE /admin/services/:id (soft deactivate)", () => {
  test("deactivates, is idempotent, keeps the row and blocks new bookings", async () => {
    const res = await call(owner, "DELETE", `/admin/services/${f.haircutId}`);
    expect(res.status).toBe(200);
    expect(adminServiceSchema.parse(await res.json()).active).toBe(false);
    expect((await call(owner, "DELETE", `/admin/services/${f.haircutId}`)).status).toBe(200);

    const booking = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    expect(booking.status).toBe(404);
    expect((await audit("service.deactivate")).length).toBe(1);
  });

  test("404 for an unknown service", async () => {
    expect((await call(owner, "DELETE", `/admin/services/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });
});

describe("PUT /admin/services/:id/staff", () => {
  const links = () =>
    t.db
      .select()
      .from(serviceStaff)
      .where(and(eq(serviceStaff.serviceId, f.colorId)));

  test("replaces the performer set, soft-deleting removed links and reviving them later", async () => {
    // Color is performed by Ana only; hand it to Bea.
    const res = await call(owner, "PUT", `/admin/services/${f.colorId}/staff`, {
      staffIds: [f.beaId],
    });
    expect(res.status).toBe(200);
    expect(adminServiceSchema.parse(await res.json()).staffIds).toEqual([f.beaId]);

    const rows = await links();
    expect(rows.find((r) => r.staffId === f.anaId)?.deletedAt).not.toBeNull();
    expect(rows.find((r) => r.staffId === f.beaId)?.deletedAt).toBeNull();

    // Ana can no longer be booked for it.
    const refused = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.colorId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    expect(refused.status).toBe(400);

    // Putting her back revives the same row instead of violating the unique constraint.
    const back = await call(owner, "PUT", `/admin/services/${f.colorId}/staff`, {
      staffIds: [f.anaId, f.beaId],
    });
    expect(adminServiceSchema.parse(await back.json()).staffIds.sort()).toEqual(
      [f.anaId, f.beaId].sort(),
    );
    expect((await links()).length).toBe(2);

    const [first, second] = await audit("service.staff_set");
    expect(first?.metadata).toMatchObject({ added: [f.beaId], removed: [f.anaId] });
    expect(second?.metadata).toMatchObject({ added: [f.anaId], removed: [] });
  });

  test("an empty list removes everyone", async () => {
    const res = await call(owner, "PUT", `/admin/services/${f.colorId}/staff`, { staffIds: [] });
    expect(adminServiceSchema.parse(await res.json()).staffIds).toEqual([]);
  });

  test("an unknown staff member is 404 and nothing changes, audit included", async () => {
    const res = await call(owner, "PUT", `/admin/services/${f.colorId}/staff`, {
      staffIds: [f.beaId, Bun.randomUUIDv7()],
    });
    expect(res.status).toBe(404);
    const live = (await links()).filter((r) => r.deletedAt === null);
    expect(live.map((r) => r.staffId)).toEqual([f.anaId]);
    expect((await audit("service.staff_set")).length).toBe(0);
  });

  test("404 for an unknown service and 400 for duplicates", async () => {
    expect(
      (await call(owner, "PUT", `/admin/services/${Bun.randomUUIDv7()}/staff`, { staffIds: [] }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(owner, "PUT", `/admin/services/${f.colorId}/staff`, {
          staffIds: [f.anaId, f.anaId],
        })
      ).status,
    ).toBe(400);
  });
});

test("category and calendar color persist through service creation and configuration", async () => {
  const created = await call(owner, "POST", "/admin/services", {
    ...newService,
    category: "Hair",
    color: "#2C7B79",
    staffIds: [f.anaId],
  });
  expect(created.status).toBe(201);
  const row = adminServiceSchema.parse(await created.json());
  expect(row).toMatchObject({ category: "Hair", color: "#2C7B79" });
  const saved = await call(owner, "PUT", `/admin/services/${row.id}/configuration`, {
    version: row.version,
    staffIds: row.staffIds,
    service: { category: "Color", color: "#9F4661" },
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const pub = listServicesResponseSchema.parse(await (await call(null, "GET", "/services")).json());
  expect(pub.services.find((s) => s.id === row.id)).toMatchObject({
    category: "Color",
    color: "#9F4661",
  });
  expect(
    (await call(owner, "PATCH", `/admin/services/${row.id}`, { color: "red;url(bad)" })).status,
  ).toBe(400);
});
