import { z } from "zod";
import { idSchema } from "./common";

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
  clientId: idSchema.nullable(),
  /** Phone on the booking profile; null for accounts without one. */
  phone: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Owner-only: creates a login with the `staff` role and its calendar profile. */
export const createStaffAccountRequestSchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  password: z.string().min(8).max(128),
  /** Name shown in the booking flow; defaults to `name`. */
  displayName: z.string().min(1).optional(),
});
export type CreateStaffAccountRequest = z.infer<typeof createStaffAccountRequestSchema>;

export const staffAccountResponseSchema = z.object({
  userId: z.string(),
  staffId: idSchema,
  email: z.string(),
  role: z.literal("staff"),
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
