import { describe, expect, test } from "bun:test";
import {
  type BookingSearch,
  canEnterStep,
  firstIncompleteStep,
  parseBookingSearch,
  serializeBookingSearch,
  toggleService,
} from "./search";

const A = "0198f5a0-7b1c-7000-8000-000000000101";
const B = "0198f5a0-7b1c-7000-8000-000000000102";
const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";

describe("parseBookingSearch", () => {
  test("reads services, professional, date and slot from the URL", () => {
    expect(
      parseBookingSearch({
        services: `${A},${B}`,
        staff: STAFF,
        date: "2026-03-09",
        slot: "2026-03-09T12:00:00.000Z",
        slotStaff: STAFF,
      }),
    ).toEqual({
      services: [A, B],
      staff: STAFF,
      date: "2026-03-09",
      slot: "2026-03-09T12:00:00.000Z",
      slotStaff: STAFF,
    });
  });

  test("accepts services as an array too (router may pre-parse)", () => {
    expect(parseBookingSearch({ services: [A, B] }).services).toEqual([A, B]);
  });

  test("drops malformed values instead of failing the page", () => {
    expect(
      parseBookingSearch({
        services: `${A},not-a-uuid`,
        staff: "someone",
        date: "tomorrow",
        slot: "noon",
      }),
    ).toEqual({ services: [A] });
  });

  test("keeps 'any' as the professional choice and removes duplicate services", () => {
    const parsed = parseBookingSearch({ services: `${A},${A}`, staff: "any" });
    expect(parsed.staff).toBe("any");
    expect(parsed.services).toEqual([A]);
  });

  test("empty input is an empty selection", () => {
    expect(parseBookingSearch({})).toEqual({ services: [] });
  });
});

describe("serializeBookingSearch", () => {
  test("round-trips and omits empty fields", () => {
    const search: BookingSearch = { services: [A, B], staff: "any", date: "2026-03-09" };
    expect(serializeBookingSearch(search)).toEqual({
      services: `${A},${B}`,
      staff: "any",
      date: "2026-03-09",
    });
    expect(parseBookingSearch(serializeBookingSearch(search))).toEqual(search);
    expect(serializeBookingSearch({ services: [] })).toEqual({});
  });
});

describe("toggleService", () => {
  test("adds and removes while keeping the choice order", () => {
    const first = toggleService({ services: [] }, A);
    expect(first.services).toEqual([A]);
    expect(toggleService(first, B).services).toEqual([A, B]);
    expect(toggleService(toggleService(first, B), A).services).toEqual([B]);
  });

  test("changing services invalidates the downstream choices", () => {
    const next = toggleService(
      {
        services: [A],
        staff: STAFF,
        date: "2026-03-09",
        slot: "2026-03-09T12:00:00.000Z",
        slotStaff: STAFF,
      },
      B,
    );
    expect(next).toEqual({ services: [A, B] });
  });
});

describe("firstIncompleteStep", () => {
  test("walks the funnel in order", () => {
    expect(firstIncompleteStep({ services: [] })).toBe("services");
    expect(firstIncompleteStep({ services: [A] })).toBe("professional");
    expect(firstIncompleteStep({ services: [A], staff: "any" })).toBe("time");
    expect(
      firstIncompleteStep({
        services: [A],
        staff: "any",
        slot: "2026-03-09T12:00:00.000Z",
        slotStaff: STAFF,
      }),
    ).toBe("review");
  });

  test("a slot without a concrete professional is not complete", () => {
    expect(
      firstIncompleteStep({ services: [A], staff: "any", slot: "2026-03-09T12:00:00.000Z" }),
    ).toBe("time");
  });
});

describe("canEnterStep", () => {
  test("a step is reachable only when every earlier step is complete", () => {
    expect(canEnterStep({ services: [] }, "services")).toBe(true);
    expect(canEnterStep({ services: [] }, "professional")).toBe(false);
    expect(canEnterStep({ services: [A] }, "professional")).toBe(true);
    expect(canEnterStep({ services: [A] }, "time")).toBe(false);
    expect(canEnterStep({ services: [A], staff: "any" }, "time")).toBe(true);
    expect(canEnterStep({ services: [A], staff: "any" }, "review")).toBe(false);
    expect(canEnterStep({ services: [A], staff: "any" }, "services")).toBe(true);
  });
});
