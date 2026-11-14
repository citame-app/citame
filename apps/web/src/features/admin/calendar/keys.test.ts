import { describe, expect, test } from "bun:test";
import { keyboardMove, shortcutFor } from "./keys";

describe("shortcutFor", () => {
  const key = (k: string, extra: Partial<Parameters<typeof shortcutFor>[0]> = {}) =>
    shortcutFor({ key: k, ...extra });

  test("maps the documented keys", () => {
    expect(key("t")).toBe("today");
    expect(key("ArrowLeft")).toBe("previous");
    expect(key("ArrowRight")).toBe("next");
    expect(key("[")).toBe("previous");
    expect(key("]")).toBe("next");
    expect(key("d")).toBe("day");
    expect(key("w")).toBe("week");
    expect(key("n")).toBe("new");
    expect(key("r")).toBe("refresh");
    expect(key("?")).toBe("help");
  });

  test("never fires while typing, with modifiers, or for unknown keys", () => {
    expect(key("n", { typing: true })).toBeNull();
    expect(key("n", { ctrlKey: true })).toBeNull();
    expect(key("n", { metaKey: true })).toBeNull();
    expect(key("n", { altKey: true })).toBeNull();
    expect(key("x")).toBeNull();
  });

  test("is case-insensitive for letters", () => {
    expect(key("T")).toBe("today");
  });
});

describe("keyboardMove", () => {
  const base = {
    startsAt: "2026-03-09T12:00:00.000Z",
    staffId: "a",
    staffIds: ["a", "b", "c"],
    granularity: 15,
  };

  test("Alt+Up and Alt+Down move by one slot", () => {
    expect(keyboardMove({ ...base, key: "ArrowDown", altKey: true })).toEqual({
      startsAt: "2026-03-09T12:15:00.000Z",
      staffId: "a",
    });
    expect(keyboardMove({ ...base, key: "ArrowUp", altKey: true })).toEqual({
      startsAt: "2026-03-09T11:45:00.000Z",
      staffId: "a",
    });
  });

  test("Alt+Left and Alt+Right move to the neighbouring column and stop at the edges", () => {
    expect(keyboardMove({ ...base, key: "ArrowRight", altKey: true })).toEqual({
      startsAt: base.startsAt,
      staffId: "b",
    });
    expect(keyboardMove({ ...base, key: "ArrowLeft", altKey: true })).toBeNull();
    expect(keyboardMove({ ...base, staffId: "c", key: "ArrowRight", altKey: true })).toBeNull();
  });

  test("plain arrows do nothing here", () => {
    expect(keyboardMove({ ...base, key: "ArrowDown", altKey: false })).toBeNull();
  });
});
