import { describe, expect, test } from "bun:test";
import { meResponseSchema, salonResponseSchema, updateProfileRequestSchema } from "./index";

describe("salon", () => {
  test("describes the public salon information the booking flow needs", () => {
    const parsed = salonResponseSchema.parse({
      name: "Sisters of Beauty",
      timezone: "America/Argentina/Buenos_Aires",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 60,
      maxDaysAhead: 60,
    });
    expect(parsed.maxDaysAhead).toBe(60);
  });

  test("rejects a salon without a timezone", () => {
    expect(salonResponseSchema.safeParse({ name: "X" }).success).toBe(false);
  });
});

describe("profile", () => {
  test("accepts a trimmed name and a phone, or a null phone to clear it", () => {
    expect(
      updateProfileRequestSchema.parse({ name: "  Lucia  ", phone: "+54 9 11 5555-0000" }),
    ).toEqual({
      name: "Lucia",
      phone: "+54 9 11 5555-0000",
    });
    expect(updateProfileRequestSchema.parse({ phone: null }).phone).toBeNull();
  });

  test("rejects an empty update, a blank name and a nonsense phone", () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ phone: "abc" }).success).toBe(false);
  });

  test("the me response exposes the phone number", () => {
    const parsed = meResponseSchema.parse({
      user: { id: "u", email: "a@example.com", name: "A", role: "client" },
      staffId: null,
      clientId: null,
      phone: null,
    });
    expect(parsed.phone).toBeNull();
  });
});
