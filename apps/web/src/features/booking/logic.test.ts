import { describe, expect, test } from "bun:test";
import type { Service, Slot, Staff } from "@sob/contracts";
import {
  bookingTotals,
  buildDateStrip,
  eligibleStaff,
  firstAvailableDate,
  groupSlots,
  partOfDay,
  timezoneDifference,
} from "./logic";

const TZ = "America/Argentina/Buenos_Aires";
const id = (n: number) => `0198f5a0-7b1c-7000-8000-${n.toString(16).padStart(12, "0")}`;

const service = (n: number, durationMinutes: number, priceCents: number): Service => ({
  id: id(n),
  name: `S${n}`,
  description: null,
  durationMinutes,
  bufferMinutes: 10,
  priceCents,
  currency: "ARS",
});

describe("bookingTotals", () => {
  test("sums duration and price of the selected services", () => {
    const catalog = [service(1, 45, 1000), service(2, 30, 500), service(3, 90, 4000)];
    expect(bookingTotals(catalog, [id(1), id(3)])).toEqual({
      durationMinutes: 135,
      priceCents: 5000,
      currency: "ARS",
      count: 2,
    });
  });

  test("ignores ids that are not in the catalog and handles an empty selection", () => {
    const catalog = [service(1, 45, 1000)];
    expect(bookingTotals(catalog, [id(9)]).count).toBe(0);
    expect(bookingTotals(catalog, [])).toEqual({
      durationMinutes: 0,
      priceCents: 0,
      currency: null,
      count: 0,
    });
  });
});

describe("eligibleStaff", () => {
  const staff: Staff[] = [
    { id: id(0x201), displayName: "A", serviceIds: [id(1), id(2)] },
    { id: id(0x202), displayName: "B", serviceIds: [id(2)] },
  ];

  test("keeps only professionals who perform every selected service", () => {
    expect(eligibleStaff(staff, [id(2)]).map((s) => s.displayName)).toEqual(["A", "B"]);
    expect(eligibleStaff(staff, [id(1), id(2)]).map((s) => s.displayName)).toEqual(["A"]);
    expect(eligibleStaff(staff, [id(1), id(3)])).toEqual([]);
  });
});

describe("partOfDay", () => {
  test("splits the salon-local day into morning, afternoon and evening", () => {
    expect(partOfDay("2026-03-09T12:00:00.000Z", TZ)).toBe("morning"); // 09:00
    expect(partOfDay("2026-03-09T15:00:00.000Z", TZ)).toBe("afternoon"); // 12:00
    expect(partOfDay("2026-03-09T19:59:00.000Z", TZ)).toBe("afternoon"); // 16:59
    expect(partOfDay("2026-03-09T20:00:00.000Z", TZ)).toBe("evening"); // 17:00
  });
});

describe("groupSlots", () => {
  const slot = (startsAt: string, staffId = id(0x201)): Slot => ({
    staffId,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  });

  test("groups in chronological order and drops empty groups", () => {
    const groups = groupSlots(
      [
        slot("2026-03-09T20:30:00.000Z"),
        slot("2026-03-09T12:00:00.000Z"),
        slot("2026-03-09T16:00:00.000Z"),
      ],
      TZ,
    );
    expect(groups.map((g) => g.part)).toEqual(["morning", "afternoon", "evening"]);
    expect(groups[0]?.slots[0]?.startsAt).toBe("2026-03-09T12:00:00.000Z");
    expect(groupSlots([slot("2026-03-09T12:00:00.000Z")], TZ).map((g) => g.part)).toEqual(["morning"]);
  });

  test("with several professionals one start time appears once, on the first professional", () => {
    const groups = groupSlots(
      [
        slot("2026-03-09T12:00:00.000Z", id(0x202)),
        slot("2026-03-09T12:00:00.000Z", id(0x201)),
        slot("2026-03-09T12:30:00.000Z", id(0x202)),
      ],
      TZ,
    );
    const morning = groups[0]?.slots ?? [];
    expect(morning.map((s) => s.startsAt)).toEqual([
      "2026-03-09T12:00:00.000Z",
      "2026-03-09T12:30:00.000Z",
    ]);
    expect(morning[0]?.staffId).toBe(id(0x201));
  });

  test("no slots, no groups", () => {
    expect(groupSlots([], TZ)).toEqual([]);
  });
});

describe("buildDateStrip", () => {
  test("lists consecutive local dates starting today, capped by the booking horizon", () => {
    expect(buildDateStrip("2026-03-30", 4, 60)).toEqual([
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
    ]);
    expect(buildDateStrip("2026-03-30", 10, 3)).toEqual(["2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02"]);
  });
});

describe("firstAvailableDate", () => {
  test("is the earliest date known to have slots; unknown and empty days are skipped", () => {
    expect(
      firstAvailableDate(["2026-03-09", "2026-03-10", "2026-03-11"], {
        "2026-03-09": 0,
        "2026-03-11": 4,
        "2026-03-10": undefined,
      }),
    ).toBe("2026-03-11");
    expect(firstAvailableDate(["2026-03-09"], { "2026-03-09": 0 })).toBeUndefined();
  });
});

describe("timezoneDifference", () => {
  test("is null when the visitor is on the salon's clock", () => {
    expect(timezoneDifference("America/Argentina/Buenos_Aires", TZ, new Date("2026-03-09T12:00:00Z"))).toBeNull();
    // An alias of the same zone is not a difference either.
    expect(timezoneDifference("America/Buenos_Aires", TZ, new Date("2026-03-09T12:00:00Z"))).toBeNull();
  });

  test("reports the visitor zone and the hour offset when it differs", () => {
    expect(timezoneDifference("Europe/Madrid", TZ, new Date("2026-03-09T12:00:00Z"))).toEqual({
      visitorTimeZone: "Europe/Madrid",
      offsetMinutes: 240,
    });
  });
});
