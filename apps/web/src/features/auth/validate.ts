import { createStaffAccountRequestSchema, phoneSchema } from "@sob/contracts";
import { z } from "zod";
import type { Translator } from "~/i18n";

/**
 * Client-side validation built from the shared contracts, so the browser and the API agree on
 * what a valid email, name and password are. Zod's messages are English; the user sees ours.
 */
const signUpSchema = createStaffAccountRequestSchema.pick({
  email: true,
  name: true,
  password: true,
});
const signInSchema = createStaffAccountRequestSchema
  .pick({ email: true })
  .extend({ password: z.string().min(1) });

export type AuthMode = "sign-in" | "sign-up";
export type FieldErrors = Partial<Record<string, string>>;
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

export interface SignInValues {
  email: string;
  password: string;
}
export interface SignUpValues extends SignInValues {
  name: string;
}

function messageFor(t: Translator, field: string, issue: z.core.$ZodIssue, mode: AuthMode) {
  if (field === "email") return t("validation.email");
  if (field === "name") return t("validation.name");
  if (field === "phone") return t("validation.phone");
  if (field === "password") {
    if (mode === "sign-in") return t("validation.password.required");
    return issue.code === "too_big" ? t("validation.password.max") : t("validation.password.min");
  }
  return issue.message;
}

function collect(
  t: Translator,
  error: z.ZodError,
  mode: AuthMode,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (!errors[field]) errors[field] = messageFor(t, field, issue, mode);
  }
  return errors;
}

export function validateAuth(
  mode: "sign-in",
  values: SignInValues,
  t: Translator,
): ValidationResult<SignInValues>;
export function validateAuth(
  mode: "sign-up",
  values: SignUpValues,
  t: Translator,
): ValidationResult<SignUpValues>;
export function validateAuth(
  mode: AuthMode,
  values: SignInValues | SignUpValues,
  t: Translator,
): ValidationResult<SignInValues | SignUpValues> {
  const cleaned = {
    ...values,
    email: values.email.trim(),
    ...("name" in values ? { name: values.name.trim() } : {}),
  };
  const result = (mode === "sign-in" ? signInSchema : signUpSchema).safeParse(cleaned);
  if (!result.success) return { ok: false, errors: collect(t, result.error, mode) };
  return { ok: true, data: result.data as SignInValues | SignUpValues };
}

const profileSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.union([z.literal(""), phoneSchema]),
});

export function validateProfile(
  values: { name: string; phone: string },
  t: Translator,
): ValidationResult<{ name: string; phone: string | null }> {
  const result = profileSchema.safeParse(values);
  if (!result.success) return { ok: false, errors: collect(t, result.error, "sign-up") };
  return {
    ok: true,
    data: { name: result.data.name, phone: result.data.phone === "" ? null : result.data.phone },
  };
}
