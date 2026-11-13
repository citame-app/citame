import { describe, expect, test } from "bun:test";
import { reportQuerySchema, reportSummarySchema, statusCountsSchema } from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const counts = { booked: 1, completed: 3, cancelled: 1, no_show: 1 };

describe("report query", () => {
  test("accepts local dates, an optional staffId, and a one-day range", () => {
    expect(reportQuerySchema.safeParse({ from: "2026-03-09", to: "2026-03-11" }).success).toBe(
      true,
    );
    expect(
      reportQuerySchema.safeParse({ from: "2026-03-09", to: "2026-03-09", staffId: uuid }).success,
    ).toBe(true);
  });

  test("rejects instants, malformed dates, inverted ranges and absurdly long ranges", () => {
    for (const bad of [
      { from: "2026-03-09T00:00:00Z", to: "2026-03-10" },
      { from: "09/03/2026", to: "2026-03-10" },
      { from: "2026-03-10", to: "2026-03-09" },
      { from: "2025-01-01", to: "2026-03-09" },
      { from: "2026-03-09" },
      { from: "2026-03-09", to: "2026-03-10", staffId: "nope" },
    ]) {
      expect(reportQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  test("a range of exactly 366 days is allowed", () => {
    expect(reportQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-01" }).success).toBe(
      true,
    );
    expect(reportQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-02" }).success).toBe(
      false,
    );
  });
});

describe("report summary", () => {
  const summary = {
    from: "2026-03-09",
    to: "2026-03-11",
    timezone: "America/Argentina/Buenos_Aires",
    staffId: null,
    totals: { appointments: 6, byStatus: counts, revenueCents: 55000, noShowRate: 0.25 },
    series: [{ date: "2026-03-09", appointments: 2, byStatus: counts, revenueCents: 45000 }],
    topServices: [{ serviceId: uuid, name: "Haircut", count: 3, revenueCents: 30000 }],
    perStaff: [
      {
        staffId: uuid,
        displayName: "Ana",
        appointments: 4,
        byStatus: counts,
        revenueCents: 45000,
        noShowRate: null,
      },
    ],
  };

  test("parses a full summary", () => {
    expect(reportSummarySchema.parse(summary).totals.revenueCents).toBe(55000);
  });

  test("status counts require every status", () => {
    expect(statusCountsSchema.safeParse(counts).success).toBe(true);
    expect(statusCountsSchema.safeParse({ booked: 1 }).success).toBe(false);
  });

  test("rates are fractions between 0 and 1 or null", () => {
    expect(
      reportSummarySchema.safeParse({
        ...summary,
        totals: { ...summary.totals, noShowRate: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      reportSummarySchema.safeParse({
        ...summary,
        totals: { ...summary.totals, noShowRate: null },
      }).success,
    ).toBe(true);
  });
});
