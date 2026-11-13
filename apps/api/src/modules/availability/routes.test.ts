import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { availabilityResponseSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, timeOff } from "@sob/db";
import {
  type Fixtures,
  MONDAY,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

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

async function availability(query: string) {
  const res = await t.app.request(`/availability?${query}`);
  return { res, body: (await res.json()) as unknown };
}

describe("GET /availability", () => {
  test("returns slots for every qualified staff member when staffId is omitted", async () => {
    const { res, body } = await availability(`serviceIds=${f.haircutId}&date=${MONDAY}`);
    expect(res.status).toBe(200);
    const parsed = availabilityResponseSchema.parse(body);
    expect(parsed.date).toBe(MONDAY);
    expect(parsed.timezone).toBe("America/Argentina/Buenos_Aires");
    // 09:00-18:00 with a 60 minute block on a 30 minute grid: 17 starts per staff member.
    expect(parsed.slots.filter((s) => s.staffId === f.anaId)).toHaveLength(17);
    expect(parsed.slots.filter((s) => s.staffId === f.beaId)).toHaveLength(17);
    expect(parsed.slots[0]?.startsAt).toBe(MONDAY_0900);
    expect(parsed.slots[0]?.endsAt).toBe("2026-03-09T13:00:00.000Z");
  });

  test("filters by staffId", async () => {
    const { body } = await availability(
      `serviceIds=${f.haircutId}&staffId=${f.beaId}&date=${MONDAY}`,
    );
    const parsed = availabilityResponseSchema.parse(body);
    expect(new Set(parsed.slots.map((s) => s.staffId))).toEqual(new Set([f.beaId]));
  });

  test("only staff who perform every requested service are considered", async () => {
    const { body } = await availability(`serviceIds=${f.colorId}&date=${MONDAY}`);
    const parsed = availabilityResponseSchema.parse(body);
    expect(new Set(parsed.slots.map((s) => s.staffId))).toEqual(new Set([f.anaId]));
    expect(parsed.slots).toHaveLength(16); // 90 minute block

    const both = availabilityResponseSchema.parse(
      (await availability(`serviceIds=${f.haircutId},${f.colorId}&date=${MONDAY}`)).body,
    );
    // 60 + 90 = 150 minute block, Ana only.
    expect(both.slots).toHaveLength(14);
    expect(both.slots.every((s) => s.staffId === f.anaId)).toBe(true);
    expect(both.slots[0]?.endsAt).toBe("2026-03-09T14:30:00.000Z");
  });

  test("a staff member who does not perform the service yields no slots", async () => {
    const { res, body } = await availability(
      `serviceIds=${f.colorId}&staffId=${f.beaId}&date=${MONDAY}`,
    );
    expect(res.status).toBe(200);
    expect(availabilityResponseSchema.parse(body).slots).toEqual([]);
  });

  test("booked appointments block slots; cancelled ones do not", async () => {
    const block = {
      staffId: f.anaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    };
    await t.db.insert(appointment).values(block);
    const blocked = availabilityResponseSchema.parse(
      (await availability(`serviceIds=${f.haircutId}&staffId=${f.anaId}&date=${MONDAY}`)).body,
    );
    expect(blocked.slots[0]?.startsAt).toBe("2026-03-09T13:00:00.000Z");

    await t.db.insert(appointment).values({
      ...block,
      staffId: f.beaId,
      status: "cancelled",
    });
    const free = availabilityResponseSchema.parse(
      (await availability(`serviceIds=${f.haircutId}&staffId=${f.beaId}&date=${MONDAY}`)).body,
    );
    expect(free.slots[0]?.startsAt).toBe(MONDAY_0900);
  });

  test("time off removes slots", async () => {
    await t.db.insert(timeOff).values({
      staffId: f.anaId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T15:00:00Z"),
      reason: "Dentist",
    });
    const parsed = availabilityResponseSchema.parse(
      (await availability(`serviceIds=${f.haircutId}&staffId=${f.anaId}&date=${MONDAY}`)).body,
    );
    expect(parsed.slots[0]?.startsAt).toBe("2026-03-09T15:00:00.000Z");
  });

  test("applies minimum notice using the injected clock", async () => {
    // NOW is Monday 2026-03-02 09:00 local and the salon requires 60 minutes of notice.
    const parsed = availabilityResponseSchema.parse(
      (await availability(`serviceIds=${f.haircutId}&staffId=${f.anaId}&date=2026-03-02`)).body,
    );
    expect(parsed.slots[0]?.startsAt).toBe("2026-03-02T13:00:00.000Z");
  });

  test("returns 404 for an unknown service or staff member", async () => {
    const unknown = "0198f5a0-7b1c-7000-8000-0000000000ff";
    const svc = await availability(`serviceIds=${unknown}&date=${MONDAY}`);
    expect(svc.res.status).toBe(404);
    expect(errorResponseSchema.parse(svc.body).error.code).toBe("not_found");
    const stf = await availability(`serviceIds=${f.haircutId}&staffId=${unknown}&date=${MONDAY}`);
    expect(stf.res.status).toBe(404);
  });

  test("returns 400 validation_error for bad queries", async () => {
    for (const query of [
      `serviceIds=${f.haircutId}`,
      `date=${MONDAY}`,
      `serviceIds=not-a-uuid&date=${MONDAY}`,
      `serviceIds=${f.haircutId}&date=09-03-2026`,
    ]) {
      const { res, body } = await availability(query);
      expect(res.status).toBe(400);
      expect(errorResponseSchema.parse(body).error.code).toBe("validation_error");
    }
  });
});
