import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { reviewedStaffAccessSchema } from "@sob/contracts";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { assignRole } from "../../auth/accounts";
import { loadPrincipal } from "../../auth/principal";
import { setStaffAccess } from "./access";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let member: Actor;
let other: Actor;
const key = () => crypto.randomUUID();
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
const access = (preset: string, version = 1) =>
  call(owner, `/admin/staff/${member.staffId}/access`, "PUT", { preset, version });
const calendar = () =>
  call(member, "/appointments/calendar?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z");
async function receipt(staffId: string | null) {
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    staffId,
    lines: [{ kind: "custom", description: "Private sale", quantity: 1, unitAmountCents: 1000 }],
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "staff_access" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const f = await seedFixtures(t.db);
  [owner, member, other] = await Promise.all([
    actor(t, "owner", "access-owner@example.com"),
    actor(t, "staff", "access-member@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "access-other@example.com", { staffProfileId: f.beaId }),
  ]);
});
test("owner changes access with a version fence, existing sessions see it immediately and staff cannot self-escalate", async () => {
  expect((await access("manager")).status).toBe(200);
  const me = (await (await call(member, "/me")).json()) as {
    accessPreset: string;
    user: { role: string };
  };
  expect(me).toMatchObject({ accessPreset: "manager", user: { role: "staff" } });
  expect((await access("restricted", 1)).status).toBe(409);
  expect(
    (
      await call(member, `/admin/staff/${member.staffId}/access`, "PUT", {
        preset: "manager",
        version: 2,
      })
    ).status,
  ).toBe(403);
  expect(
    (await call(member, "/admin/staff-accounts", "POST", { name: "No", email: "no@example.com" }))
      .status,
  ).toBe(403);
});
test("professionals see only their own receipts and cannot read the salon cash balance", async () => {
  const own = await receipt(member.staffId);
  const another = await receipt(other.staffId);
  const listed = (await (await call(member, "/admin/commerce/checkouts")).json()) as {
    checkouts: { id: string }[];
  };
  expect(listed.checkouts.map((row) => row.id)).toEqual([own.id]);
  expect((await call(member, `/admin/commerce/checkouts/${another.id}`)).status).toBe(404);
  expect(
    (
      await call(member, `/admin/commerce/checkouts/${another.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 1000,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(404);
  expect((await call(member, "/admin/commerce/cash-sessions/current")).status).toBe(403);
});

test("role changes invalidate an access review even if the account returns to the staff role", async () => {
  const path = `/admin/staff/${member.staffId}/access/reviewed`;
  const before = reviewedStaffAccessSchema.parse(await (await call(owner, path)).json());
  await assignRole(t.db, member.userId, "owner");
  const promoted = reviewedStaffAccessSchema.parse(await (await call(owner, path)).json());
  expect(promoted.access).toMatchObject({
    version: before.access.version + 1,
    accountRole: "owner",
  });
  await assignRole(t.db, member.userId, "staff");
  const stale = await call(owner, path, "PUT", {
    generation: before.generation,
    accountId: before.accountId,
    version: before.access.version,
    preset: "manager",
  });
  expect(stale.status).toBe(409);
});

test("the access write rechecks the owner's authority inside its transaction", async () => {
  const path = `/admin/staff/${member.staffId}/access/reviewed`;
  const before = reviewedStaffAccessSchema.parse(await (await call(owner, path)).json());
  const principal = await loadPrincipal(t.db, owner.userId);
  if (!principal) throw new Error("Missing test owner");
  await assignRole(t.db, owner.userId, "staff");
  await expect(
    setStaffAccess(
      t.db,
      before.access.staffId,
      {
        generation: before.generation,
        accountId: before.accountId,
        version: before.access.version,
        preset: "manager",
      },
      principal,
      before.generation,
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
});
test("restricted access can read its calendar but cannot mutate bookings or enter sales, clients or inventory", async () => {
  expect((await access("restricted")).status).toBe(200);
  expect((await calendar()).status).toBe(200);
  expect((await call(member, "/admin/commerce/checkouts")).status).toBe(403);
  expect((await call(member, "/admin/inventory/products")).status).toBe(403);
  expect((await call(member, "/admin/clients")).status).toBe(403);
  const response = await call(member, "/appointments", "POST", {
    staffId: member.staffId,
    serviceIds: ["0198f5a0-7b1c-7000-8000-000000000101"],
    startsAt: "2026-03-09T12:00:00Z",
    client: { name: "Not allowed" },
  });
  expect(response.status).toBe(403);
});
test("reception sees all calendars and receipts, manages the register and cannot inspect costs or change access", async () => {
  expect((await access("receptionist")).status).toBe(200);
  const response = await calendar();
  expect(response.status).toBe(200);
  expect(((await response.json()) as { staff: unknown[] }).staff).toHaveLength(2);
  await receipt(member.staffId);
  await receipt(other.staffId);
  expect(
    ((await (await call(member, "/admin/commerce/checkouts")).json()) as { checkouts: unknown[] })
      .checkouts,
  ).toHaveLength(2);
  expect(
    (await call(member, "/admin/commerce/cash-sessions", "POST", { openingCents: 1000 })).status,
  ).toBe(201);
  expect((await call(member, "/admin/accounting/sales?from=2026-03-09&to=2026-03-10")).status).toBe(
    403,
  );
  expect((await call(member, `/admin/staff/${other.staffId}/access`)).status).toBe(403);
});
test("manager can administer retail and commissions while account and salon settings remain owner-controlled", async () => {
  expect((await access("manager")).status).toBe(200);
  const product = await call(member, "/admin/inventory/products", "POST", {
    name: "Manager product",
    sku: "MG-1",
    priceCents: 1000,
    costCents: 300,
    openingStock: 1,
    idempotencyKey: key(),
  });
  expect(product.status).toBe(201);
  expect(await product.json()).toMatchObject({ costCents: 300 });
  expect(
    (
      await call(member, `/admin/accounting/staff/${other.staffId}/policy`, "PUT", {
        serviceBasisPoints: 2000,
        productBasisPoints: 1000,
        version: null,
      })
    ).status,
  ).toBe(200);
  expect(
    (await call(member, "/admin/settings", "PATCH", { name: "Unauthorized rename" })).status,
  ).toBe(403);
});
test("restricted accounts cannot bypass sales permissions through the customer checkout routes", async () => {
  const sale = await receipt(member.staffId);
  await access("restricted");
  expect((await call(member, `/me/checkouts/${sale.id}`)).status).toBe(403);
  expect((await call(member, `/me/checkouts/${sale.id}/void`, "POST", {})).status).toBe(403);
  expect(
    (
      await call(member, `/me/checkouts/${sale.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 1000,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(403);
});
