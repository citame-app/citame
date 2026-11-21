import { z } from "zod";
import { idSchema, LIMITS, syncGenerationSchema } from "./common";
import { reviewedStaffAccessSchema, staffAccessPresetSchema } from "./permissions";

export const userRoleSchema = z.enum(["owner", "staff", "client"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** The authenticated caller and the profiles linked to their account. */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: userRoleSchema,
  }),
  staffId: idSchema.nullable(),
  accessPreset: staffAccessPresetSchema.nullable().optional(),
  clientId: idSchema.nullable(),
  /** Phone on the booking profile; null for accounts without one. */
  phone: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Password bounds shared by sign-up, reset and staff creation (Better Auth enforces the same). */
export const passwordSchema = z.string().min(8).max(128);

/**
 * Owner-only: creates a login with the `staff` role and its calendar profile. Without a
 * `password` the person is invited: they receive an email link and choose their own.
 */
export const createStaffAccountRequestSchema = z
  .strictObject({
    email: z.email().max(LIMITS.email),
    name: z.string().min(1).max(LIMITS.name),
    password: passwordSchema.optional(),
    /** Name shown in the booking flow; defaults to `name`. */
    displayName: z.string().min(1).max(LIMITS.name).optional(),
    existingCalendar: z
      .strictObject({
        staffId: idSchema,
        version: z.number().int().positive(),
        generation: syncGenerationSchema,
      })
      .optional(),
  })
  .refine(({ existingCalendar, displayName }) => !existingCalendar || displayName === undefined, {
    message: "An existing staff calendar keeps its display name",
    path: ["displayName"],
  });
export type CreateStaffAccountRequest = z.infer<typeof createStaffAccountRequestSchema>;

export const staffAccountResponseSchema = z.object({
  userId: z.string(),
  staffId: idSchema,
  email: z.string(),
  role: z.literal("staff"),
  /** True when no password was given and an invitation email was queued. */
  invited: z.boolean().default(false),
  reviewedAccess: reviewedStaffAccessSchema.optional(),
});
export type StaffAccountResponse = z.infer<typeof staffAccountResponseSchema>;

/** Owner-only: promotes or demotes an existing account. */
export const changeRoleRequestSchema = z.object({ role: userRoleSchema });
export type ChangeRoleRequest = z.infer<typeof changeRoleRequestSchema>;

export const changeRoleResponseSchema = z.object({
  userId: z.string(),
  role: userRoleSchema,
  staffId: idSchema.nullable(),
  clientId: idSchema.nullable(),
});
export type ChangeRoleResponse = z.infer<typeof changeRoleResponseSchema>;
