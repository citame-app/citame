import { describe, expect, test } from "bun:test";
import { createTranslator } from "~/i18n";
import { validateAuth, validateProfile } from "./validate";

const en = createTranslator("en");
const es = createTranslator("es-AR");

describe("sign in validation", () => {
  test("accepts a valid email and any non-empty password, trimming the email", () => {
    const result = validateAuth("sign-in", { email: "  Lucia@Example.com ", password: "x" }, en);
    expect(result).toEqual({ ok: true, data: { email: "Lucia@Example.com", password: "x" } });
  });

  test("reports an invalid email and a missing password per field", () => {
    const result = validateAuth("sign-in", { email: "nope", password: "" }, en);
    expect(result).toEqual({
      ok: false,
      errors: {
        email: "Enter a valid email address",
        password: "Enter your password",
      },
    });
  });
});

describe("sign up validation", () => {
  test("requires a name, a valid email and a password of 8 to 128 characters", () => {
    const result = validateAuth("sign-up", { name: " ", email: "a@b", password: "short" }, en);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe("Enter your name");
      expect(result.errors.email).toBe("Enter a valid email address");
      expect(result.errors.password).toBe("Use at least 8 characters");
    }
  });

  test("rejects an overlong password", () => {
    const result = validateAuth(
      "sign-up",
      { name: "Lucia", email: "a@example.com", password: "x".repeat(129) },
      en,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toBe("Use at most 128 characters");
  });

  test("a valid sign up returns clean data", () => {
    const result = validateAuth(
      "sign-up",
      { name: " Lucia ", email: "a@example.com", password: "correct horse battery" },
      en,
    );
    expect(result).toEqual({
      ok: true,
      data: { name: "Lucia", email: "a@example.com", password: "correct horse battery" },
    });
  });

  test("messages are localized", () => {
    const result = validateAuth("sign-up", { name: "", email: "x", password: "" }, es);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBe("Ingresa tu nombre");
  });
});

describe("profile validation", () => {
  test("a name is required and the phone is optional but must look like a phone number", () => {
    expect(validateProfile({ name: "Lucia", phone: "" }, en)).toEqual({
      ok: true,
      data: { name: "Lucia", phone: null },
    });
    expect(validateProfile({ name: "Lucia", phone: "+54 9 11 5555-0000" }, en)).toEqual({
      ok: true,
      data: { name: "Lucia", phone: "+54 9 11 5555-0000" },
    });
    const bad = validateProfile({ name: "", phone: "abc" }, en);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.name).toBe("Enter your name");
      expect(bad.errors.phone).toBe("Enter a valid phone number");
    }
  });
});
