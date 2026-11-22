import { describe, expect, test } from "bun:test";
import { rangeError, resolveRange, validateReportsSearch } from "./range";

describe("validateReportsSearch", () => {
  test("defaults to the last 30 days", () => {
    expect(validateReportsSearch({})).toEqual({ preset: "last30" });
  });
  test("keeps a recognised report section for deep links", () => {
    expect(validateReportsSearch({ section: "financial" })).toEqual({
      preset: "last30",
      section: "financial",
    });
    expect(validateReportsSearch({ section: "unknown" })).toEqual({ preset: "last30" });
  });
  test("keeps presets, custom dates and a staff filter, drops junk", () => {
    const id = "0198f5a0-7b1c-7000-8000-000000000201";
    expect(
      validateReportsSearch({ preset: "custom", from: "2026-03-01", to: "2026-03-09", staff: id }),
    ).toEqual({ preset: "custom", from: "2026-03-01", to: "2026-03-09", staff: id });
    expect(validateReportsSearch({ preset: "nope", from: "x", staff: "y" })).toEqual({
      preset: "last30",
    });
  });
});

describe("resolveRange", () => {
  test("presets resolve against today", () => {
    expect(resolveRange({ preset: "last7" }, "2026-03-18")).toEqual({
      from: "2026-03-12",
      to: "2026-03-18",
    });
  });
  test("custom uses its dates, falling back to the last 30 days when incomplete", () => {
    expect(
      resolveRange({ preset: "custom", from: "2026-03-01", to: "2026-03-05" }, "2026-03-18"),
    ).toEqual({ from: "2026-03-01", to: "2026-03-05" });
    expect(resolveRange({ preset: "custom" }, "2026-03-18")).toEqual({
      from: "2026-02-17",
      to: "2026-03-18",
    });
  });
});

describe("rangeError", () => {
  test("flags reversed and over-long ranges", () => {
    expect(rangeError({ from: "2026-03-05", to: "2026-03-01" })).toBe("order");
    expect(rangeError({ from: "2024-01-01", to: "2026-03-01" })).toBe("tooLong");
    expect(rangeError({ from: "2026-03-01", to: "2026-03-05" })).toBeNull();
  });
});
