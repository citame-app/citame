import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointment,
  appointmentContext,
  appointmentService,
  checkout,
  clientProfile,
  reminder,
  service,
  serviceAddon,
  staffProfile,
} from "@sob/db";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { eq, sql } from "drizzle-orm";
import { getBookableServices, listServices } from "../services/service";
import { transferFixture } from "./fixtures";
import { planBooksyTransfer, sourceUuid } from "./plan";
import { applyBooksyRehearsal } from "./rehearsal";
import { holdBooksyCombinations, reviewBooksyCombinations } from "./source-combinations";
import { verifyBooksyProjection } from "./verify";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase("booksy_transfer");
  const input = transferFixture();
  await applyBooksyRehearsal(t.db, input, planBooksyTransfer(input).review.reviewHash);
});
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate booksy_rehearsal.entity,booksy_rehearsal.run`);
});
afterAll(async () => {
  await t.close();
});
test("imports a frozen visit once with private source notes and no financial or client notification side effects", async () => {
  const input = transferFixture();
  const hash = planBooksyTransfer(input).review.reviewHash;
  expect((await applyBooksyRehearsal(t.db, input, hash)).reconciled).toBe(true);
  expect((await applyBooksyRehearsal(t.db, input, hash)).reconciled).toBe(true);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  expect(await t.db.select().from(appointmentService)).toHaveLength(1);
  expect(await t.db.select().from(staffProfile)).toHaveLength(1);
  expect(await t.db.select().from(service)).toHaveLength(1);
  expect(await t.db.select().from(clientProfile)).toHaveLength(1);
  const [segment] = await t.db.select().from(appointmentService);
  expect(segment?.priceCents).toBe(5000);
  const [context] = await t.db.select().from(appointmentContext);
  expect(context).toMatchObject({
    internalNote: "PRIVATE",
    invoiced: true,
    paid: false,
    source: "booksy",
  });
  expect(await t.db.select().from(checkout)).toHaveLength(0);
  expect(await t.db.select().from(reminder)).toHaveLength(0);
  const raw = await t.db.execute<{ raw: { raw: { unknownSourceField: string } } }>(
    sql`select raw from booksy_rehearsal.entity where kind='staff'`,
  );
  expect(raw[0]?.raw.raw.unknownSourceField).toBe("preserved");
});
test("source changes and local edits, including a service snapshot edit, never overwrite either copy", async () => {
  const input = transferFixture();
  await applyBooksyRehearsal(t.db, input, planBooksyTransfer(input).review.reviewHash);
  const changed = structuredClone(input);
  changed.staff[0]!.name = "Changed source";
  await expect(
    applyBooksyRehearsal(t.db, changed, planBooksyTransfer(changed).review.reviewHash),
  ).rejects.toThrow("Source changed");
  await t.db
    .update(appointmentService)
    .set({ name: "Locally corrected" })
    .where(
      eq(
        appointmentService.id,
        sourceUuid(input.businessId, "appointmentServices", "booked-service-1"),
      ),
    );
  await expect(
    applyBooksyRehearsal(t.db, input, planBooksyTransfer(input).review.reviewHash),
  ).rejects.toThrow("Local target changed");
  const [row] = await t.db.select().from(appointmentService);
  expect(row?.name).toBe("Locally corrected");
});

test("imports only reviewed add-on eligibility and detects a missing native relationship", async () => {
  const input = transferFixture();
  input.services.push({
    ...input.services[0]!,
    sourceId: "addon:1",
    name: "Synthetic add-on",
    catalogKind: "addon",
    addonParentRefs: ["service-1"],
  });
  const plan = planBooksyTransfer(input);
  await applyBooksyRehearsal(t.db, input, plan.review.reviewHash);
  await applyBooksyRehearsal(t.db, input, plan.review.reviewHash);
  const parent = sourceUuid(input.businessId, "services", "service-1");
  const addon = sourceUuid(input.businessId, "services", "addon:1");
  expect(await t.db.select().from(serviceAddon)).toEqual([{ addonId: addon, serviceId: parent }]);
  expect(await getBookableServices(t.db, [parent, addon])).toHaveLength(2);
  await expect(getBookableServices(t.db, [addon])).rejects.toThrow("eligible preceding service");
  await t.db.delete(serviceAddon).where(eq(serviceAddon.addonId, addon));
  await expect(verifyBooksyProjection(t.db, input)).rejects.toThrow("eligibility differs");
  await expect(applyBooksyRehearsal(t.db, input, plan.review.reviewHash)).rejects.toThrow(
    "eligibility differs",
  );
});

test("discounted source combinations preserve the ordered evidence and stay off the bookable catalogue", async () => {
  const input = transferFixture();
  const first = input.services[0]!;
  first.raw = { variants: [{ id: 1, price: "55.00", duration: 60, staffers: [1, 2] }] };
  const second = {
    ...first,
    sourceId: "service-2",
    raw: { variants: [{ id: 2, price: "55.00", duration: 60, staffers: [1, 2] }] },
  };
  const sourceCombo = {
    ...first,
    sourceId: "source-combo",
    durationMinutes: 120,
    priceCents: 9500,
    raw: {
      combo_type: "S",
      is_available_for_customer_booking: true,
      variants: [
        {
          id: 3,
          price: "95.00",
          duration: 120,
          staffers: [1],
          combo_children: [
            { service_variant: { id: 2 }, price: "45.00" },
            { service_variant: { id: 1 }, price: "50.00" },
          ],
        },
      ],
    },
  };
  input.services.push(second, sourceCombo);
  input.services = holdBooksyCombinations(input.services);
  expect(input.services[2]).toEqual({ ...sourceCombo, active: false });
  expect(sourceCombo.active).toBe(true);
  expect(reviewBooksyCombinations(input.services)).toEqual({
    captured: 1,
    held: 1,
    publiclyOfferedAtSource: 1,
    discountedVersusCatalogue: 1,
    differentQualifiedStaff: 1,
    differentDuration: 0,
    componentPriceMismatch: 0,
    unverifiedTerms: 0,
  });
  const plan = planBooksyTransfer(input);
  await applyBooksyRehearsal(t.db, input, plan.review.reviewHash);
  const comboId = sourceUuid(input.businessId, "services", sourceCombo.sourceId);
  expect(await listServices(t.db)).not.toContainEqual(expect.objectContaining({ id: comboId }));
  await expect(getBookableServices(t.db, [comboId])).rejects.toThrow("not found");
  const [retained] = await t.db.select().from(service).where(eq(service.id, comboId));
  expect(retained).toMatchObject({ active: false, priceCents: 9500, durationMinutes: 120 });
});
test("an invalid reference or a capacity conflict rolls back every new entity rather than dropping a visit", async () => {
  const input = transferFixture();
  input.appointments.push({
    ...structuredClone(input.appointments[0]!),
    sourceId: "booking-2",
    services: [{ ...input.appointments[0]!.services[0]!, sourceId: "booked-service-2" }],
  });
  await expect(
    applyBooksyRehearsal(t.db, input, planBooksyTransfer(input).review.reviewHash),
  ).rejects.toThrow();
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(await t.db.select().from(staffProfile)).toHaveLength(0);
  expect(await t.db.select().from(clientProfile)).toHaveLength(0);
});
