import { describe, expect, test } from "bun:test";
import {
  changeRoleRequestSchema,
  createStaffAccountRequestSchema,
  errorCodeSchema,
  errorStatus,
  meResponseSchema,
  passwordSchema,
  staffAccountResponseSchema,
  userRoleSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";

describe("auth error codes", () => {
  test("unauthorized, forbidden and rate_limited are stable codes with HTTP statuses", () => {
    for (const code of ["unauthorized", "forbidden", "rate_limited"]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(errorStatus.unauthorized).toBe(401);
    expect(errorStatus.forbidden).toBe(403);
    expect(errorStatus.rate_limited).toBe(429);
  });
});

describe("roles", () => {
  test("only owner, staff and client exist", () => {
    expect(userRoleSchema.options).toEqual(["owner", "staff", "client"]);
    expect(userRoleSchema.safeParse("admin").success).toBe(false);
  });

  test("role change accepts a known role only", () => {
    expect(changeRoleRequestSchema.safeParse({ role: "staff" }).success).toBe(true);
    expect(changeRoleRequestSchema.safeParse({ role: "root" }).success).toBe(false);
    expect(changeRoleRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("staff account creation", () => {
  const valid = { email: "ana@example.com", name: "Ana", password: "correct horse battery" };

  test("accepts email, name and a password of sane length", () => {
    expect(createStaffAccountRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      createStaffAccountRequestSchema.safeParse({ ...valid, displayName: "Ana M." }).success,
    ).toBe(true);
  });

  test("rejects bad emails and weak or oversized passwords", () => {
    expect(createStaffAccountRequestSchema.safeParse({ ...valid, email: "nope" }).success).toBe(
      false,
    );
    expect(createStaffAccountRequestSchema.safeParse({ ...valid, password: "short" }).success).toBe(
      false,
    );
    expect(
      createStaffAccountRequestSchema.safeParse({ ...valid, password: "x".repeat(129) }).success,
    ).toBe(false);
  });
});

describe("staff invitation", () => {
  test("a staff account may be created without a password: the person sets it from an invitation", () => {
    const parsed = createStaffAccountRequestSchema.parse({ email: "bea@example.com", name: "Bea" });
    expect(parsed.password).toBeUndefined();
  });

  test("the shared password schema keeps the same bounds for sign-up and reset", () => {
    expect(passwordSchema.safeParse("correct horse").success).toBe(true);
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  test("the response says whether an invitation was sent", () => {
    const base = { userId: "u", staffId: "0195c0de-0000-7000-8000-000000000001", email: "a@b.co" };
    expect(
      staffAccountResponseSchema.parse({ ...base, role: "staff", invited: true }).invited,
    ).toBe(true);
    expect(staffAccountResponseSchema.parse({ ...base, role: "staff" }).invited).toBe(false);
  });
});

describe("me", () => {
  test("describes the principal with its profile ids", () => {
    const me = meResponseSchema.parse({
      user: { id: "u1", email: "a@example.com", name: "A", role: "client" },
      staffId: null,
      clientId: uuid,
      phone: null,
    });
    expect(me.clientId).toBe(uuid);
    expect(
      meResponseSchema.safeParse({
        user: { id: "u1", email: "a@example.com", name: "A", role: "wizard" },
        staffId: null,
        clientId: null,
        phone: null,
      }).success,
    ).toBe(false);
  });
});
