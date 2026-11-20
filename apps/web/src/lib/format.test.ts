import { describe, expect, test } from "bun:test";

const plain = (value: string) => value.replace(/\s/g, " ");

import {
  addDaysLocal,
  formatDateLong,
  formatDuration,
  formatMoney,
  formatTime,
  localDateOf,
  weekdayShort,
} from "./format";

const TZ = "America/Argentina/Buenos_Aires";

describe("formatMoney", () => {
  test("formats cents in the given currency and locale", () => {
    expect(formatMoney(1_500_000, "ARS", "es-AR")).toBe("$ 15.000");
    expect(formatMoney(1_250, "USD", "en")).toBe("$12.50");
  });

  test("drops the decimals only when the amount is whole", () => {
    expect(formatMoney(1_000, "USD", "en")).toBe("$10");
    expect(formatMoney(1_001, "USD", "en")).toBe("$10.01");
  });
});

describe("formatDuration", () => {
  test("renders hours and minutes for the locale", () => {
    expect(formatDuration(45, "en")).toBe("45m");
    expect(formatDuration(75, "en")).toBe("1h 15m");
    expect(formatDuration(120, "es-AR")).toBe("2h");
    expect(formatDuration(45, "es-AR")).toBe("45min");
  });
});

describe("salon timezone dates", () => {
  const instant = "2026-03-09T12:00:00.000Z"; // 09:00 in Buenos Aires (UTC-3)

  test("formats a time in the salon timezone, not the runtime one", () => {
    expect(plain(formatTime(instant, TZ, "en"))).toBe("9:00 AM");
    expect(formatTime(instant, TZ, "es-AR")).toBe("09:00");
    expect(formatTime(instant, "Asia/Tokyo", "es-AR")).toBe("21:00");
  });

  test("never emits a narrow no-break space, which differs between server and browser ICU and breaks hydration", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    // Simulate a browser whose ICU separates the day period with U+202F.
    class NarrowSpaceFormat extends RealDateTimeFormat {
      override format = (date?: Date | number) =>
        RealDateTimeFormat.prototype.formatToParts
          .call(this, date)
          .map((part) => (part.type === "literal" && part.value === " " ? "\u202f" : part.value))
          .join("");
    }
    Intl.DateTimeFormat = NarrowSpaceFormat as typeof Intl.DateTimeFormat;
    try {
      // Use a fresh formatter key rather than the cached one from the previous test.
      expect(formatTime(instant, "Etc/UTC", "en")).toBe("12:00 PM");
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
    }
  });

  test("derives the salon-local calendar date of an instant", () => {
    expect(localDateOf("2026-03-10T02:30:00.000Z", TZ)).toBe("2026-03-09");
    expect(localDateOf("2026-03-10T02:30:00.000Z", "Asia/Tokyo")).toBe("2026-03-10");
  });

  test("formats a long local date in the locale", () => {
    expect(formatDateLong("2026-03-09", "en")).toBe("Monday, March 9");
    expect(formatDateLong("2026-03-09", "es-AR")).toBe("lunes, 9 de marzo");
  });

  test("adds days to a local date without drifting across month and DST edges", () => {
    expect(addDaysLocal("2026-02-27", 3)).toBe("2026-03-02");
    expect(addDaysLocal("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysLocal("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("weekdayShort uses the locale", () => {
    expect(weekdayShort("2026-03-09", "en")).toBe("Mon");
    expect(weekdayShort("2026-03-09", "es-AR")).toBe("lun");
  });
});
