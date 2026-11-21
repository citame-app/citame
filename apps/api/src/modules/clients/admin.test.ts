import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  adminClientSchema,
  appointmentSchema,
  clientDetailResponseSchema,
  errorResponseSchema,
  listClientsResponseSchema,
} from "@sob/contracts";
import { auditLog, clientProfile, marketingConsent } from "@sob/db";
import { asc, eq } from "drizzle-orm";
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
let marta: string;
let zoe: string;

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
    actor(t, "client", "nina@example.com"),
  ]);
  // Lucia (fixture) and nina (the client login) plus two more with distinct creation times.
  const [m, z] = await t.db
    .insert(clientProfile)
    .values([
      {
        name: "Marta Gomez",
        phone: "+54 9 11 5555-0000",
        email: "marta@example.com",
        createdAt: new Date("2026-01-10T00:00:00Z"),
      },
      {
        name: "Zoe Ruiz",
        phone: "+54 9 11 4444-1111",
        email: "zoe@example.org",
        createdAt: new Date("2026-02-10T00:00:00Z"),
      },
    ])
    .returning();
  marta = m?.id ?? "";
  zoe = z?.id ?? "";
});

const call = (who: Actor | null, method: string, path: string, body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const errorCode = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;
const list = async (who: Actor, query = "") =>
  listClientsResponseSchema.parse(await (await call(who, "GET", `/admin/clients${query}`)).json());
const audit = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));

async function book(clientId: string, startsAt = MONDAY_0900, staffId = f.anaId) {
  const res = await call(owner, "POST", "/appointments", {
    staffId,
    serviceIds: [f.haircutId],
    startsAt,
    clientId,
  });
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

describe("access control", () => {
  test("anonymous callers get 401 and clients get 403", async () => {
    const cases: [string, string, unknown][] = [
      ["GET", "/admin/clients", undefined],
      ["GET", `/admin/clients/${marta}`, undefined],
      ["PATCH", `/admin/clients/${marta}`, { notes: "x" }],
      ["DELETE", `/admin/clients/${marta}`, undefined],
    ];
    for (const [method, path, body] of cases) {
      expect([path, (await call(null, method, path, body)).status]).toEqual([path, 401]);
      expect([path, (await call(client, method, path, body)).status]).toEqual([path, 403]);
    }
  });

  test("staff see and edit every client, even ones they never served", async () => {
    expect((await list(ana)).total).toBe(4);
    expect((await call(ana, "GET", `/admin/clients/${marta}`)).status).toBe(200);
    expect((await call(ana, "PATCH", `/admin/clients/${marta}`, { notes: "VIP" })).status).toBe(
      200,
    );
  });

  test("only the owner can delete, and staff attempts change nothing", async () => {
    const res = await call(ana, "DELETE", `/admin/clients/${marta}`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
    expect((await list(owner)).total).toBe(4);
  });
});

describe("GET /admin/clients", () => {
  test("lists everyone by name with the paging envelope and visit stats", async () => {
    const body = await list(owner);
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 4 });
    expect(body.clients.map((c) => c.name)).toEqual(["Lucia", "Marta Gomez", "nina", "Zoe Ruiz"]);
    expect(body.clients[0]).toMatchObject({ appointmentCount: 0, lastVisitAt: null });
  });

  test("paginates and reports the total across pages", async () => {
    const first = await list(owner, "?pageSize=2&page=1");
    const second = await list(owner, "?pageSize=2&page=2");
    const third = await list(owner, "?pageSize=2&page=3");
    expect(first.clients.map((c) => c.name)).toEqual(["Lucia", "Marta Gomez"]);
    expect(second.clients.map((c) => c.name)).toEqual(["nina", "Zoe Ruiz"]);
    expect(first.total).toBe(4);
    expect(second).toMatchObject({ page: 2, pageSize: 2, total: 4 });
    expect(third.clients).toEqual([]);
  });

  test("searches name, email and phone, case-insensitively and across phone formatting", async () => {
    const names = async (q: string) =>
      (await list(owner, `?search=${encodeURIComponent(q)}`)).clients.map((c) => c.name);
    expect(await names("marta")).toEqual(["Marta Gomez"]);
    expect(await names("GOMEZ")).toEqual(["Marta Gomez"]);
    expect(await names("example.org")).toEqual(["Zoe Ruiz"]);
    expect(await names("5555")).toEqual(["Marta Gomez"]);
    expect(await names("(11) 4444")).toEqual(["Zoe Ruiz"]);
    expect(await names("nobody")).toEqual([]);
  });

  test("wildcard characters in the search are literal", async () => {
    expect((await list(owner, "?search=%25")).total).toBe(0);
    expect((await list(owner, "?search=_")).total).toBe(0);
  });

  test("search total reflects the filtered set", async () => {
    const body = await list(owner, "?search=example&pageSize=1");
    expect(body.total).toBe(3); // marta, zoe and nina@example.com
    expect(body.clients).toHaveLength(1);
  });

  test("sorts by creation date and by last visit with never-visited clients last", async () => {
    const created = await list(owner, "?sort=createdAt&order=desc");
    expect(created.clients[0]?.name).toBe("nina"); // created last, newest
    expect(created.clients.at(-1)?.name).toBe("Marta Gomez");

    await book(zoe, "2026-03-09T12:00:00.000Z");
    await book(marta, "2026-03-09T15:00:00.000Z");
    const recent = await list(owner, "?sort=lastVisitAt&order=desc");
    expect(recent.clients.map((c) => c.name)).toEqual(["Marta Gomez", "Zoe Ruiz", "Lucia", "nina"]);
    const oldest = await list(owner, "?sort=lastVisitAt&order=asc");
    expect(oldest.clients.map((c) => c.name)).toEqual(["Zoe Ruiz", "Marta Gomez", "Lucia", "nina"]);
  });

  test("counts only non-cancelled appointments and reports the latest start", async () => {
    await book(f.clientId, "2026-03-09T12:00:00.000Z");
    const later = await book(f.clientId, "2026-03-09T15:00:00.000Z");
    const cancelled = await book(f.clientId, "2026-03-09T17:00:00.000Z");
    await call(owner, "PATCH", `/appointments/${cancelled.id}`, {
      version: cancelled.version,
      status: "cancelled",
    });
    const lucia = (await list(owner)).clients.find((c) => c.id === f.clientId);
    expect(lucia).toMatchObject({ appointmentCount: 2, lastVisitAt: later.startsAt });
  });

  test("rejects bad paging and sort keys with 400", async () => {
    for (const q of ["?page=0", "?pageSize=1000", "?sort=password", "?order=up"]) {
      const res = await call(owner, "GET", `/admin/clients${q}`);
      expect([q, res.status]).toEqual([q, 400]);
      expect(await errorCode(res)).toBe("validation_error");
    }
  });
});

describe("GET /admin/clients/:id", () => {
  test("returns the profile with the full appointment history, newest first", async () => {
    const first = await book(f.clientId, "2026-03-09T12:00:00.000Z");
    const second = await book(f.clientId, "2026-03-09T15:00:00.000Z", f.beaId);
    const res = await call(owner, "GET", `/admin/clients/${f.clientId}`);
    expect(res.status).toBe(200);
    const body = clientDetailResponseSchema.parse(await res.json());
    expect(body.client).toMatchObject({ id: f.clientId, name: "Lucia", appointmentCount: 2 });
    expect(body.appointments.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(body.appointments[0]?.services[0]?.name).toBe("Haircut");
  });

  test("404 for an unknown or deleted client and 400 for a malformed id", async () => {
    expect((await call(owner, "GET", `/admin/clients/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call(owner, "GET", "/admin/clients/nope")).status).toBe(400);
  });
});

describe("PATCH /admin/clients/:id", () => {
  test("changes only a standalone contact email and withdraws consent for the previous address", async () => {
    const detail = async (id: string) =>
      clientDetailResponseSchema.parse(
        await (await call(owner, "GET", `/admin/clients/${id}`)).json(),
      ).client;
    const before = await detail(marta);
    expect(before.emailEditable).toBe(true);
    await t.db.insert(marketingConsent).values(
      (["email", "sms"] as const).map((channel) => ({
        clientId: marta,
        channel,
        enabled: true,
        source: "Synthetic consent",
        version: 1,
      })),
    );
    const path = `/admin/clients/${marta}`;
    const reviewed = (email: string | null, expectedUpdatedAt = before.updatedAt) => ({
      emailChange: { email, expectedUpdatedAt },
    });
    const changed = await call(ana, "PATCH", path, reviewed("corrected@example.org"));
    expect(changed.status).toBe(200);
    const saved = adminClientSchema.parse(await changed.json());
    expect(saved.email).toBe("corrected@example.org");
    const [contact] = await t.db.select().from(clientProfile).where(eq(clientProfile.id, marta));
    expect(contact?.userId).toBeNull();
    expect(
      await t.db.select().from(marketingConsent).where(eq(marketingConsent.clientId, marta)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "email", enabled: false, version: 2 }),
        expect.objectContaining({ channel: "sms", enabled: true, version: 1 }),
      ]),
    );
    expect((await audit("client.update")).at(-1)?.metadata).toEqual({ changed: ["email"] });
    expect((await call(owner, "PATCH", path, reviewed("stale@example.org"))).status).toBe(409);
    const cleared = await call(owner, "PATCH", path, reviewed(null, saved.updatedAt));
    expect(adminClientSchema.parse(await cleared.json()).email).toBeNull();
    const linked = await detail(client.clientId!);
    expect(linked.emailEditable).toBe(false);
    expect(
      (
        await call(
          owner,
          "PATCH",
          `/admin/clients/${linked.id}`,
          reviewed("elsewhere@example.org", linked.updatedAt),
        )
      ).status,
    ).toBe(403);
    expect((await detail(linked.id)).email).toBe(linked.email);
  });

  test("updates name, phone and notes, audits only the changed field names", async () => {
    const res = await call(owner, "PATCH", `/admin/clients/${marta}`, {
      name: "Marta G.",
      phone: "+5491100001111",
      notes: "Prefers mornings",
    });
    expect(res.status).toBe(200);
    expect(adminClientSchema.parse(await res.json())).toMatchObject({
      name: "Marta G.",
      phone: "+5491100001111",
      notes: "Prefers mornings",
      email: "marta@example.com",
    });
    const [row] = await audit("client.update");
    expect(row).toMatchObject({ actorUserId: owner.userId, entity: "client", entityId: marta });
    expect(row?.metadata).toEqual({ changed: ["name", "notes", "phone"] });
  });

  test("null clears phone and notes", async () => {
    await call(owner, "PATCH", `/admin/clients/${marta}`, { notes: "x" });
    const res = await call(owner, "PATCH", `/admin/clients/${marta}`, { phone: null, notes: null });
    expect(adminClientSchema.parse(await res.json())).toMatchObject({ phone: null, notes: null });
  });

  test("identity fields in the body are ignored", async () => {
    const res = await call(owner, "PATCH", `/admin/clients/${marta}`, {
      notes: "x",
      email: "evil@example.com",
    });
    expect(adminClientSchema.parse(await res.json()).email).toBe("marta@example.com");
  });

  test("an unchanged value is a no-op without an audit row", async () => {
    await call(owner, "PATCH", `/admin/clients/${marta}`, { name: "Marta Gomez" });
    expect((await audit("client.update")).length).toBe(0);
  });

  test("404 for unknown clients and 400 for empty or invalid bodies", async () => {
    expect(
      (await call(owner, "PATCH", `/admin/clients/${Bun.randomUUIDv7()}`, { notes: "x" })).status,
    ).toBe(404);
    expect((await call(owner, "PATCH", `/admin/clients/${marta}`, {})).status).toBe(400);
    expect((await call(owner, "PATCH", `/admin/clients/${marta}`, { name: "" })).status).toBe(400);
  });
});

describe("DELETE /admin/clients/:id", () => {
  test("soft-deletes: hidden everywhere, row kept, audited, history untouched", async () => {
    const past = await t.db.select().from(clientProfile).where(eq(clientProfile.id, marta));
    expect(past).toHaveLength(1);
    const res = await call(owner, "DELETE", `/admin/clients/${marta}`);
    expect(res.status).toBe(200);
    expect((await list(owner)).clients.map((c) => c.id)).not.toContain(marta);
    expect((await call(owner, "GET", `/admin/clients/${marta}`)).status).toBe(404);
    const [row] = await t.db.select().from(clientProfile).where(eq(clientProfile.id, marta));
    expect(row?.deletedAt).not.toBeNull();
    expect((await audit("client.delete")).length).toBe(1);
    // cannot be booked any more, and deleting twice is a 404
    const booking = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: marta,
    });
    expect(booking.status).toBe(404);
    expect((await call(owner, "DELETE", `/admin/clients/${marta}`)).status).toBe(404);
  });

  test("a client with upcoming appointments cannot be deleted until they are cancelled", async () => {
    const booked = await book(marta);
    const res = await call(owner, "DELETE", `/admin/clients/${marta}`);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("has_future_appointments");
    expect((await list(owner)).total).toBe(4);
    expect((await audit("client.delete")).length).toBe(0);

    await call(owner, "PATCH", `/appointments/${booked.id}`, {
      version: booked.version,
      status: "cancelled",
    });
    expect((await call(owner, "DELETE", `/admin/clients/${marta}`)).status).toBe(200);
  });
});

describe("a deleted client who still has a login", () => {
  test("is restored on their next request instead of being locked out", async () => {
    const profileId = client.clientId ?? "";
    expect((await call(owner, "DELETE", `/admin/clients/${profileId}`)).status).toBe(200);
    expect((await list(owner)).clients.map((c) => c.id)).not.toContain(profileId);

    const me = await call(client, "GET", "/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { clientId: string | null }).clientId).toBe(profileId);
    expect((await list(owner)).clients.map((c) => c.id)).toContain(profileId);

    const booking = await call(client, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
    });
    expect(booking.status).toBe(201);
    const rows = await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.userId, client.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });
});

test("standalone contact creation is replay-safe, grouped by tags and never links a login", async () => {
  const input = {
    id: crypto.randomUUID(),
    name: "Walk-in contact",
    email: "nina@example.com",
    phone: "+34 600 123 123",
    tags: ["VIP", "Hair"],
    notes: "Private salon note",
  };
  const created = await call(owner, "POST", "/admin/clients", input);
  expect(created.status, await created.clone().text()).toBe(201);
  expect(await created.json()).toMatchObject({
    id: input.id,
    name: input.name,
    tags: ["vip", "hair"],
    appointmentCount: 0,
  });
  const repeated = await call(owner, "POST", "/admin/clients", input);
  expect(repeated.status).toBe(201);
  const changed = await call(owner, "POST", "/admin/clients", {
    ...input,
    name: "Changed request",
  });
  expect(changed.status).toBe(409);
  expect(
    (await call(client, "POST", "/admin/clients", { ...input, id: crypto.randomUUID() })).status,
  ).toBe(403);
  const [saved] = await t.db.select().from(clientProfile).where(eq(clientProfile.id, input.id));
  expect(saved?.userId).toBeNull();
  const groups = await call(ana, "GET", "/admin/clients/groups");
  expect(await groups.json()).toEqual({
    groups: [
      { name: "hair", count: 1 },
      { name: "vip", count: 1 },
    ],
  });
  const filtered = await call(owner, "GET", "/admin/clients?tag=VIP");
  expect(await filtered.json()).toMatchObject({ total: 1, clients: [{ id: input.id }] });
});

test("imported tag spellings count and filter the same clients", async () => {
  await t.db
    .update(clientProfile)
    .set({ tags: ["  ＶＩＰ  ", "VIP"] })
    .where(eq(clientProfile.id, marta));
  await t.db
    .update(clientProfile)
    .set({ tags: ["vip"] })
    .where(eq(clientProfile.id, zoe));

  const groups = await call(owner, "GET", "/admin/clients/groups");
  expect(await groups.json()).toEqual({ groups: [{ name: "vip", count: 2 }] });
  const filtered = await call(owner, "GET", "/admin/clients?tag=VIP");
  expect(await filtered.json()).toMatchObject({
    total: 2,
    clients: [{ id: marta, tags: ["  ＶＩＰ  ", "VIP"] }, { id: zoe }],
  });
});

test("extended client details validate birthdays and reject a stale reviewed version", async () => {
  const input = {
    contactDetails: {
      firstName: "Ada",
      lastName: "Lovelace",
      taxId: "DOC-TEST",
      address: "Test district",
      birthday: { month: 2, day: 29, year: 2000 },
      discountBasisPoints: 1250,
    },
    detailsVersion: 1,
  };
  const saved = await call(owner, "PATCH", `/admin/clients/${marta}`, input);
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(await saved.json()).toMatchObject({ ...input, detailsVersion: 2 });
  expect((await call(owner, "PATCH", `/admin/clients/${marta}`, input)).status).toBe(409);
  expect(
    (
      await call(owner, "PATCH", `/admin/clients/${marta}`, {
        ...input,
        detailsVersion: 2,
        contactDetails: { birthday: { month: 2, day: 29, year: 2001 } },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(owner, "PATCH", `/admin/clients/${marta}`, {
        contactDetails: input.contactDetails,
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(owner, "PATCH", `/admin/clients/${marta}`, { detailsVersion: 2 })).status,
  ).toBe(400);
});
