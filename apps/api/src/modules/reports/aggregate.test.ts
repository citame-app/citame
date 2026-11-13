import { describe, expect, test } from "bun:test";
import { type AggregateInput, buildReportSummary, type DayStaffStatusRow } from "./aggregate";

const ANA = "0198f5a0-7b1c-7000-8000-00000000000a";
const BEA = "0198f5a0-7b1c-7000-8000-00000000000b";
const HAIRCUT = "0198f5a0-7b1c-7000-8000-000000000101";
const COLOR = "0198f5a0-7b1c-7000-8000-000000000102";

const row = (
  date: string,
  staffId: string,
  status: DayStaffStatusRow["status"],
  count: number,
  revenueCents = 0,
): DayStaffStatusRow => ({ date, staffId, status, count, revenueCents });

/**
 * Hand-computed fixture (see the integration test for the same data as real appointments):
 *   03-09  Ana: 2 completed, 45000        03-10  Ana: 1 no_show, 1 cancelled
 *   03-10  Bea: 1 completed, 10000        03-11  Bea: 1 booked
 */
const base: AggregateInput = {
  from: "2026-03-09",
  to: "2026-03-11",
  timezone: "America/Argentina/Buenos_Aires",
  staffId: null,
  rows: [
    row("2026-03-09", ANA, "completed", 2, 45000),
    row("2026-03-10", ANA, "no_show", 1),
    row("2026-03-10", ANA, "cancelled", 1),
    row("2026-03-10", BEA, "completed", 1, 10000),
    row("2026-03-11", BEA, "booked", 1),
  ],
  serviceRows: [
    { serviceId: COLOR, name: "Color", count: 1, revenueCents: 25000 },
    { serviceId: HAIRCUT, name: "Haircut", count: 3, revenueCents: 30000 },
  ],
  staff: [
    { id: BEA, displayName: "Bea" },
    { id: ANA, displayName: "Ana" },
  ],
};

describe("buildReportSummary", () => {
  const summary = buildReportSummary(base);

  test("echoes the query context", () => {
    expect(summary).toMatchObject({
      from: "2026-03-09",
      to: "2026-03-11",
      timezone: "America/Argentina/Buenos_Aires",
      staffId: null,
    });
  });

  test("totals: counts by status, revenue from completed only, no-show rate", () => {
    expect(summary.totals).toEqual({
      appointments: 6,
      byStatus: { booked: 1, completed: 3, cancelled: 1, no_show: 1 },
      revenueCents: 55000,
      // 1 no-show out of 4 appointments that should have happened (3 completed + 1 no-show)
      noShowRate: 0.25,
    });
  });

  test("series has one zero-filled entry per local date, in order", () => {
    expect(summary.series.map((d) => d.date)).toEqual(["2026-03-09", "2026-03-10", "2026-03-11"]);
    expect(summary.series[0]).toEqual({
      date: "2026-03-09",
      appointments: 2,
      byStatus: { booked: 0, completed: 2, cancelled: 0, no_show: 0 },
      revenueCents: 45000,
    });
    expect(summary.series[1]).toEqual({
      date: "2026-03-10",
      appointments: 3,
      byStatus: { booked: 0, completed: 1, cancelled: 1, no_show: 1 },
      revenueCents: 10000,
    });
    expect(summary.series[2]?.byStatus.booked).toBe(1);
  });

  test("days without appointments are present with zeros", () => {
    const quiet = buildReportSummary({ ...base, rows: [row("2026-03-11", BEA, "booked", 1)] });
    expect(quiet.series[0]).toEqual({
      date: "2026-03-09",
      appointments: 0,
      byStatus: { booked: 0, completed: 0, cancelled: 0, no_show: 0 },
      revenueCents: 0,
    });
  });

  test("per-staff breakdown, richest first, with each member's own rate", () => {
    expect(summary.perStaff).toEqual([
      {
        staffId: ANA,
        displayName: "Ana",
        appointments: 4,
        byStatus: { booked: 0, completed: 2, cancelled: 1, no_show: 1 },
        revenueCents: 45000,
        noShowRate: 0.3333,
      },
      {
        staffId: BEA,
        displayName: "Bea",
        appointments: 2,
        byStatus: { booked: 1, completed: 1, cancelled: 0, no_show: 0 },
        revenueCents: 10000,
        noShowRate: 0,
      },
    ]);
  });

  test("staff with no appointments still appear, ties broken by name", () => {
    const result = buildReportSummary({ ...base, rows: [] });
    expect(result.perStaff.map((s) => [s.displayName, s.appointments])).toEqual([
      ["Ana", 0],
      ["Bea", 0],
    ]);
  });

  test("top services ranked by count, then revenue, then name", () => {
    expect(summary.topServices.map((s) => s.name)).toEqual(["Haircut", "Color"]);
    const tied = buildReportSummary({
      ...base,
      serviceRows: [
        { serviceId: null, name: "Zeta", count: 2, revenueCents: 100 },
        { serviceId: COLOR, name: "Color", count: 2, revenueCents: 100 },
        { serviceId: HAIRCUT, name: "Haircut", count: 2, revenueCents: 500 },
      ],
    });
    expect(tied.topServices.map((s) => s.name)).toEqual(["Haircut", "Color", "Zeta"]);
  });

  test("top services keep the ten best", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      serviceId: null,
      name: `S${String(i).padStart(2, "0")}`,
      count: 12 - i,
      revenueCents: 0,
    }));
    const result = buildReportSummary({ ...base, serviceRows: many });
    expect(result.topServices).toHaveLength(10);
    expect(result.topServices[0]?.name).toBe("S00");
  });

  test("no-show rate is null when nothing should have happened yet", () => {
    const result = buildReportSummary({
      ...base,
      rows: [row("2026-03-11", BEA, "booked", 2), row("2026-03-11", BEA, "cancelled", 1)],
    });
    expect(result.totals.noShowRate).toBeNull();
    expect(result.perStaff.find((s) => s.staffId === BEA)?.noShowRate).toBeNull();
  });

  test("a single day range and an empty result are well-formed", () => {
    const result = buildReportSummary({
      ...base,
      from: "2026-03-09",
      to: "2026-03-09",
      rows: [],
      serviceRows: [],
    });
    expect(result.series).toHaveLength(1);
    expect(result.totals).toEqual({
      appointments: 0,
      byStatus: { booked: 0, completed: 0, cancelled: 0, no_show: 0 },
      revenueCents: 0,
      noShowRate: null,
    });
  });

  test("series spans month and year boundaries correctly", () => {
    const result = buildReportSummary({ ...base, from: "2026-12-30", to: "2027-01-02", rows: [] });
    expect(result.series.map((d) => d.date)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});
