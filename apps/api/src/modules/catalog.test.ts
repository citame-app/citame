import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  listAdminServicesResponseSchema,
  listServicesResponseSchema,
  listStaffResponseSchema,
} from "@sob/contracts";
import { service, serviceAddon, staffProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import { actor, type Fixtures, seedFixtures, setupApiTest } from "../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
});

describe("GET /services", () => {
  test("lists active services ordered by name, matching the contract", async () => {
    const res = await t.app.request("/services");
    expect(res.status).toBe(200);
    const body = listServicesResponseSchema.parse(await res.json());
    expect(body.services.map((s) => s.name)).toEqual(["Color", "Haircut"]);
    expect(body.services.find((s) => s.id === f.haircutId)).toMatchObject({
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 10000,
      currency: "ARS",
    });
  });

  test("hides inactive and soft-deleted services", async () => {
    await t.db.update(service).set({ active: false }).where(eq(service.id, f.colorId));
    await t.db.update(service).set({ deletedAt: new Date() }).where(eq(service.id, f.haircutId));
    const body = listServicesResponseSchema.parse(await (await t.app.request("/services")).json());
    expect(body.services).toEqual([]);
  });

  test("unconfigured imported add-ons remain editable without appearing in the public catalogue", async () => {
    const [addon] = await t.db
      .insert(service)
      .values({
        name: "Imported add-on",
        catalogKind: "addon",
        durationMinutes: 0,
        priceCents: 500,
      })
      .returning();
    if (!addon) throw new Error("Expected the fixture add-on");
    const owner = await actor(t, "owner", "catalog-owner@example.com");
    const admin = await t.app.request("/admin/services", { headers: { cookie: owner.cookie } });
    expect(admin.status).toBe(200);
    expect(listAdminServicesResponseSchema.parse(await admin.json()).services).toContainEqual(
      expect.objectContaining({
        id: addon.id,
        catalog: { kind: "addon", version: 1, allowedServiceIds: [] },
      }),
    );
    const publicIds = async () =>
      listServicesResponseSchema
        .parse(await (await t.app.request("/services")).json())
        .services.map(({ id }) => id);
    expect(await publicIds()).not.toContain(addon.id);
    await t.db.insert(serviceAddon).values({ addonId: addon.id, serviceId: f.haircutId });
    expect(await publicIds()).toContain(addon.id);
    await t.db.update(service).set({ active: false }).where(eq(service.id, f.haircutId));
    expect(await publicIds()).not.toContain(addon.id);
  });
});

describe("GET /staff", () => {
  test("lists active staff with the services they perform", async () => {
    const res = await t.app.request("/staff");
    expect(res.status).toBe(200);
    const body = listStaffResponseSchema.parse(await res.json());
    expect(body.staff.map((s) => s.displayName)).toEqual(["Ana", "Bea"]);
    const ana = body.staff.find((s) => s.id === f.anaId);
    const bea = body.staff.find((s) => s.id === f.beaId);
    expect(ana?.serviceIds.sort()).toEqual([f.haircutId, f.colorId].sort());
    expect(bea?.serviceIds).toEqual([f.haircutId]);
  });

  test("hides inactive and soft-deleted staff", async () => {
    await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, f.anaId));
    await t.db
      .update(staffProfile)
      .set({ deletedAt: new Date() })
      .where(eq(staffProfile.id, f.beaId));
    const body = listStaffResponseSchema.parse(await (await t.app.request("/staff")).json());
    expect(body.staff).toEqual([]);
  });
});
