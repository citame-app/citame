import { describe, expect, test } from "bun:test";
import { buildIcs, type MessageData, renderEmail, renderSms } from "./templates";

const data = (over: Partial<MessageData> = {}): MessageData => ({
  kind: "confirmation",
  locale: "en",
  salonName: "Sisters of Beauty",
  timeZone: "America/Argentina/Buenos_Aires",
  startsAt: new Date("2026-03-09T12:00:00Z"),
  endsAt: new Date("2026-03-09T13:00:00Z"),
  version: 1,
  services: ["Haircut", "Color"],
  staffName: "Ana",
  appointmentId: "0190aaaa-0000-7000-8000-000000000001",
  manageUrl: "https://salon.example/account",
  rescheduleUrl: "https://salon.example/account/appointments/x/reschedule",
  optOutUrl: "https://salon.example/notifications/opt-out?token=abc",
  ...over,
});

describe("renderEmail", () => {
  test("shows the local time in the SALON timezone, not the server's", () => {
    const { text } = renderEmail(data());
    expect(text).toContain("9:00");
    expect(text).toContain("Monday, March 9, 2026");
  });

  test("renders Argentine Spanish when the locale asks for it", () => {
    const { subject, text, html } = renderEmail(data({ locale: "es-AR" }));
    expect(subject).toContain("Turno confirmado");
    expect(text).toContain("lunes");
    expect(html).toContain('lang="es-AR"');
  });

  test("includes services, staff, salon and the manage links", () => {
    const { text, html } = renderEmail(data());
    for (const part of ["Haircut", "Color", "Ana", "Sisters of Beauty", "/account"]) {
      expect(text).toContain(part);
      expect(html).toContain(part);
    }
    expect(text).toContain("/reschedule");
  });

  test("escapes HTML in interpolated values", () => {
    const { html } = renderEmail(data({ staffName: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("html is accessible: lang, title, a heading and descriptive links", () => {
    const { html } = renderEmail(data());
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain("<h1");
    expect(html).not.toMatch(/>\s*click here\s*</i);
  });

  test("reminders carry the opt-out link and transactional messages do not", () => {
    const reminder = renderEmail(data({ kind: "reminder_24h" }));
    expect(reminder.text).toContain("token=abc");
    expect(reminder.html).toContain("token=abc");
    const confirmation = renderEmail(data());
    expect(confirmation.text).not.toContain("opt-out");
  });

  test("attaches a calendar entry for confirmations and reschedules only", () => {
    expect(renderEmail(data()).ics).toContain("BEGIN:VEVENT");
    expect(renderEmail(data({ kind: "rescheduled" })).ics).toContain("BEGIN:VEVENT");
    expect(renderEmail(data({ kind: "reminder_2h" })).ics).toBeUndefined();
    expect(renderEmail(data({ kind: "cancellation" })).ics).toBeUndefined();
  });

  test("cancellation says so and offers to rebook", () => {
    const { subject, text } = renderEmail(data({ kind: "cancellation" }));
    expect(subject.toLowerCase()).toContain("cancel");
    expect(text).toContain("https://salon.example/account");
  });
});

describe("renderSms", () => {
  test("is short, localized and mentions STOP in reminders", () => {
    const body = renderSms(data({ kind: "reminder_2h", locale: "es-AR" }));
    expect(body.length).toBeLessThan(320);
    expect(body).toContain("STOP");
    expect(body).toContain("Sisters of Beauty");
  });
});

describe("buildIcs", () => {
  test("uses stable UID, SEQUENCE and UTC times, with CRLF and escaping", () => {
    const ics = buildIcs(data({ services: ["Cut, wash; style"], version: 3 }));
    expect(ics).toContain("UID:0190aaaa-0000-7000-8000-000000000001@sistersofbeauty");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("DTSTART:20260309T120000Z");
    expect(ics).toContain("DTEND:20260309T130000Z");
    expect(ics).toContain("Cut\\, wash; style");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
