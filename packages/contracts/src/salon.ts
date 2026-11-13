import { z } from "zod";

/** Public salon information: what the booking flow needs to render dates and limits. */
export const salonResponseSchema = z.object({
  name: z.string().min(1),
  /** IANA timezone; every slot and appointment is displayed in it. */
  timezone: z.string().min(1),
  slotGranularityMinutes: z.number().int().positive(),
  minNoticeMinutes: z.number().int().min(0),
  maxDaysAhead: z.number().int().positive(),
});
export type SalonResponse = z.infer<typeof salonResponseSchema>;

/** Digits plus the usual separators; at least 6 digits. Format is not enforced beyond that. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[\d\s().-]{6,32}$/, "Enter a valid phone number")
  .refine((value) => (value.match(/\d/g) ?? []).length >= 6, "Enter a valid phone number");

/** Self-service profile edit: name and (for clients) phone. */
export const updateProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: phoneSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["name"],
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
