import { describe, expect, test } from "bun:test";
import { buildIcs, icsFileName } from "./ics";

const event = {
  uid: "0198f5a0-7b1c-7000-8000-000000000999",
  startsAt: "2026-03-09T12:00:00.000Z",
  endsAt: "2026-03-09T13:00:00.000Z",
  summary: "Haircut, Blow dry",
  description: "With Stylist A\nTotal: $25,000",
  location: "Sisters of Beauty",
  now: new Date("2026-03-01T10:20:30.000Z"),
};

describe("buildIcs", () => {
  test("produces a valid calendar with UTC times and CRLF line endings", () => {
    const ics = buildIcs(event);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("PRODID:-//Sisters of Beauty//Booking//EN\r\n");
    expect(ics).toContain(`UID:${event.uid}@sistersofbeauty\r\n`);
    expect(ics).toContain("DTSTAMP:20260301T102030Z\r\n");
    expect(ics).toContain("DTSTART:20260309T120000Z\r\n");
    expect(ics).toContain("DTEND:20260309T130000Z\r\n");
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  test("escapes commas, semicolons, backslashes and newlines in text values", () => {
    const ics = buildIcs({ ...event, summary: "A, B; C\\D" });
    expect(ics).toContain("SUMMARY:A\\, B; C\\\\D\r\n");
    expect(ics).toContain("DESCRIPTION:With Stylist A\\nTotal: $25\\,000\r\n");
  });

  test("folds lines longer than 75 octets", () => {
    const ics = buildIcs({ ...event, description: "x".repeat(200) });
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the original value.
    expect(ics.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${"x".repeat(200)}`);
  });

  test("includes a reminder one hour before", () => {
    const ics = buildIcs(event);
    expect(ics).toContain("BEGIN:VALARM\r\n");
    expect(ics).toContain("TRIGGER:-PT1H\r\n");
  });
});

describe("icsFileName", () => {
  test("is a safe, dated file name", () => {
    expect(icsFileName("2026-03-09")).toBe("appointment-2026-03-09.ics");
  });
});
