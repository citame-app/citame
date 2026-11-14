import { describe, expect, test } from "bun:test";
import type { ReportSummary } from "@sob/contracts";
import { csvCell, formatRate, presetRange, reportToCsv } from "./logic";

describe("presetRange", () => {
  const today = "2026-03-18";
  test("rolling presets end today", () => {
    expect(presetRange("today", today)).toEqual({ from: "2026-03-18", to: "2026-03-18" });
    expect(presetRange("last7", today)).toEqual({ from: "2026-03-12", to: "2026-03-18" });
    expect(presetRange("last30", today)).toEqual({ from: "2026-02-17", to: "2026-03-18" });
  });

  test("calendar month presets", () => {
    expect(presetRange("thisMonth", today)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(presetRange("lastMonth", today)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("lastMonth", "2026-01-10")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });
});

describe("formatRate", () => {
  test("a null rate has no basis", () => {
    expect(formatRate(null, "en")).toBe("-");
    expect(formatRate(0.25, "en")).toBe("25%");
    expect(formatRate(0.3333, "es-AR")).toBe("33%");
  });
});

describe("csvCell", () => {
  test("quotes commas, quotes and newlines; neutralizes spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(12.5)).toBe("12.5");
  });
});

const summary: ReportSummary = {
  from: "2026-03-09",
  to: "2026-03-10",
  timezone: "America/Argentina/Buenos_Aires",
  staffId: null,
  totals: {
    appointments: 3,
    byStatus: { booked: 0, completed: 2, cancelled: 0, no_show: 1 },
    revenueCents: 2_500_000,
    noShowRate: 1 / 3,
  },
  series: [
    {
      date: "2026-03-09",
      appointments: 2,
      byStatus: { booked: 0, completed: 1, cancelled: 0, no_show: 1 },
      revenueCents: 1_500_000,
    },
    {
      date: "2026-03-10",
      appointments: 1,
      byStatus: { booked: 0, completed: 1, cancelled: 0, no_show: 0 },
      revenueCents: 1_000_000,
    },
  ],
  topServices: [{ serviceId: null, name: "Haircut, short", count: 1, revenueCents: 1_500_000 }],
  perStaff: [
    {
      staffId: "0198f5a0-7b1c-7000-8000-000000000201",
      displayName: "Ana",
      appointments: 3,
      byStatus: { booked: 0, completed: 2, cancelled: 0, no_show: 1 },
      revenueCents: 2_500_000,
      noShowRate: 1 / 3,
    },
  ],
};

describe("reportToCsv", () => {
  const csv = reportToCsv(summary);
  const lines = csv.split("\r\n");

  test("exports the daily series, top services and per-staff blocks with machine-readable numbers", () => {
    expect(lines[0]).toBe("date,appointments,booked,completed,cancelled,no_show,revenue");
    expect(lines[1]).toBe("2026-03-09,2,0,1,0,1,15000.00");
    expect(lines[2]).toBe("2026-03-10,1,0,1,0,0,10000.00");
    expect(csv).toContain('service,completed,revenue\r\n"Haircut, short",1,15000.00');
    expect(csv).toContain(
      "staff,appointments,completed,no_show,no_show_rate,revenue\r\nAna,3,2,1,0.3333,25000.00",
    );
  });

  test("starts with a UTF-8 friendly plain text and ends with a newline", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
