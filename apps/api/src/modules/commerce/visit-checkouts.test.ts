import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { checkoutSchema, visitCheckoutSchema } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  appointmentVisit,
  appointmentVisitPart,
  checkout,
} from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let staff: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "visit_checkouts" });
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff] = await Promise.all([
    actor(t, "owner", "owner@visit-checkouts.test"),
    actor(t, "staff", "staff@visit-checkouts.test", { staffProfileId: f.anaId }),
  ]);
});

async function group(source: "itinerary" | "import") {
  const groupId = crypto.randomUUID();
  const appointments = await t.db
    .insert(appointment)
    .values(
      [f.anaId, f.beaId].map((staffId, index) => ({
        clientId: f.clientId,
        staffId,
        visitGroupId: source === "import" ? groupId : undefined,
        startsAt: new Date(Date.UTC(2026, 2, 9, 12 + index)),
        endsAt: new Date(Date.UTC(2026, 2, 9, 13 + index)),
      })),
    )
    .returning();
  await t.db.insert(appointmentService).values(
    appointments.map(({ id }, index) => ({
      appointmentId: id,
      position: 0,
      serviceId: f.haircutId,
      name: "Haircut",
      durationMinutes: 60,
      bufferMinutes: 0,
      priceCents: index === 0 ? 1200 : 1900,
      currency: "EUR",
    })),
  );
  if (source === "itinerary") {
    await t.db.insert(appointmentVisit).values({
      id: groupId,
      clientId: f.clientId,
      createdBy: owner.userId,
      requestHash: "fixture",
    });
    await t.db.insert(appointmentVisitPart).values(
      appointments.map(({ id }, index) => ({
        visitId: groupId,
        appointmentId: id,
        position: index,
      })),
    );
  }
  const [first, second] = appointments;
  if (!first || !second) throw new Error("Visit appointment insert failed");
  return { groupId, first: first.id, second: second.id };
}

function prepare(id: string, who = owner) {
  return json(t.app, `/admin/commerce/visits/${id}/checkouts`, "POST", undefined, who.cookie);
}

test.each(["itinerary", "import"] as const)(
  "the %s group prepares one frozen receipt per professional",
  async (source) => {
    const { groupId, first, second } = await group(source);
    const existing = await json(
      t.app,
      "/admin/commerce/checkouts",
      "POST",
      {
        appointmentId: first,
        idempotencyKey: crypto.randomUUID(),
      },
      owner.cookie,
    );
    expect(existing.status).toBe(201);
    const saved = checkoutSchema.parse(await existing.json());
    const replies = await Promise.all([prepare(second), prepare(first)]);
    for (const reply of replies) {
      expect(reply.status, await reply.clone().text()).toBe(200);
      const view = visitCheckoutSchema.parse(await reply.json());
      expect(view.groupId).toBe(groupId);
      expect(view.appointments.map((item) => item.receipt)).toEqual([
        expect.objectContaining({
          id: saved.id,
          appointmentId: first,
          staffId: f.anaId,
          balanceCents: 1200,
        }),
        expect.objectContaining({ appointmentId: second, staffId: f.beaId, balanceCents: 1900 }),
      ]);
    }
    expect(await t.db.select().from(checkout)).toHaveLength(2);
  },
);

test("a whole visit is hidden from operators restricted to their own receipts", async () => {
  const { first } = await group("itinerary");
  expect((await prepare(first, staff)).status).toBe(404);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("a legacy billing hold anywhere in the group prevents preparing receipts", async () => {
  const { first, second } = await group("import");
  await t.db.insert(appointmentContext).values({
    appointmentId: second,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "fixture",
    invoiced: true,
  });
  expect((await prepare(first)).status).toBe(409);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("a failure preparing the second part rolls back the first receipt", async () => {
  const { first, second } = await group("itinerary");
  await t.db.delete(appointmentService).where(eq(appointmentService.appointmentId, second));
  expect((await prepare(first)).status).toBe(400);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("a cancelled appointment stays visible without creating a receipt", async () => {
  const { first, second } = await group("itinerary");
  await t.db.update(appointment).set({ status: "cancelled" }).where(eq(appointment.id, second));
  const result = await prepare(first);
  expect(result.status, await result.clone().text()).toBe(200);
  const view = visitCheckoutSchema.parse(await result.json());
  expect(view.appointments.map(({ receipt }) => receipt?.appointmentId ?? null)).toEqual([
    first,
    null,
  ]);
  expect(await t.db.select().from(checkout)).toHaveLength(1);
});
