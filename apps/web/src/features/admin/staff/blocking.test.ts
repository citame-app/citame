import { describe, expect, test } from "bun:test";
import { chunkWindows, eligibleTargets } from "./blocking";

describe("chunkWindows", () => {
  test("splits a horizon into consecutive windows no longer than the API allows", () => {
    const windows = chunkWindows("2026-03-09T03:00:00.000Z", 100, 42);
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({
      from: "2026-03-09T03:00:00.000Z",
      to: "2026-04-20T03:00:00.000Z",
    });
    expect(windows[1]?.from).toBe("2026-04-20T03:00:00.000Z");
    expect(windows[2]?.to).toBe("2026-06-17T03:00:00.000Z");
  });

  test("a short horizon is a single window", () => {
    expect(chunkWindows("2026-03-09T03:00:00.000Z", 10, 42)).toEqual([
      { from: "2026-03-09T03:00:00.000Z", to: "2026-03-19T03:00:00.000Z" },
    ]);
  });
});

describe("eligibleTargets", () => {
  const s = (id: string, serviceIds: string[], active = true) => ({
    id,
    displayName: id,
    active,
    userId: null,
    serviceIds,
  });
  const staff = [s("a", ["x", "y"]), s("b", ["x"]), s("c", ["x", "y"], false), s("d", ["x", "y"])];

  test("only other, active staff who perform every service of the appointment", () => {
    expect(
      eligibleTargets(
        { staffId: "a", services: [{ serviceId: "x" }, { serviceId: "y" }] },
        staff,
      ).map((m) => m.id),
    ).toEqual(["d"]);
    expect(
      eligibleTargets({ staffId: "a", services: [{ serviceId: "x" }] }, staff).map((m) => m.id),
    ).toEqual(["b", "d"]);
  });

  test("a removed service (null id) cannot be matched, so nobody is eligible", () => {
    expect(eligibleTargets({ staffId: "a", services: [{ serviceId: null }] }, staff)).toEqual([]);
  });
});
