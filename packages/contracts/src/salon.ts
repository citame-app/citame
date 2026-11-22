import { z } from "zod";
import { instantSchema, syncGenerationSchema } from "./common";
import { reminderLeadSchema } from "./notifications";

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[\d\s().-]{6,32}$/, "Enter a valid phone number")
  .refine((value) => (value.match(/\d/g) ?? []).length >= 6, "Enter a valid phone number");

const shortText = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .regex(/^[^\p{Cc}\u2028\u2029]+$/u)
    .nullable();
const httpsLink = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    const link = URL.parse(value);
    return link?.protocol === "https:" && !!link.hostname && !link.username && !link.password;
  }, "Enter an HTTPS link")
  .nullable();
export const BUSINESS_AMENITIES = [
  "wifi",
  "parking",
  "accessibleEntrance",
  "cardPayments",
  "childrenWelcome",
  "petsWelcome",
] as const;
export const businessProfileContentSchema = z.strictObject({
  description: shortText(600),
  category: shortText(80),
  address: shortText(240),
  phone: phoneSchema.regex(/^[^\p{Cc}]+$/u).nullable(),
  email: z.string().trim().max(254).pipe(z.email()).nullable(),
  website: httpsLink,
  shop: httpsLink,
  instagram: httpsLink,
  rules: shortText(400),
  mobileService: z.boolean(),
  amenities: z
    .array(z.enum(BUSINESS_AMENITIES))
    .max(BUSINESS_AMENITIES.length)
    .transform((values) => BUSINESS_AMENITIES.filter((value) => values.includes(value))),
});
export const businessProfileSchema = businessProfileContentSchema.extend({
  published: z.boolean(),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export const EMPTY_BUSINESS_PROFILE: BusinessProfile = {
  published: false,
  description: null,
  category: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  shop: null,
  instagram: null,
  rules: null,
  mobileService: false,
  amenities: [],
};

/** Public salon information: what the booking flow needs to render dates and limits. */
export const salonResponseSchema = z.object({
  name: z.string().min(1),
  /** IANA timezone; every slot and appointment is displayed in it. */
  timezone: z.string().min(1),
  slotGranularityMinutes: z.number().int().positive(),
  minNoticeMinutes: z.number().int().min(0),
  maxDaysAhead: z.number().int().positive(),
  onlineBookingEnabled: z.boolean().optional(),
  profile: businessProfileContentSchema.optional(),
});
export type SalonResponse = z.infer<typeof salonResponseSchema>;

/** What the owner sees and edits: the public fields plus reminder timing. */
export const ownerSalonSettingsSchema = salonResponseSchema.extend({
  /** Minutes before the start for the first reminder (default 1440 = 24 h); null turns it off. */
  reminderFirstLeadMinutes: reminderLeadSchema,
  /** Minutes before the start for the second reminder (default 120 = 2 h); null turns it off. */
  reminderSecondLeadMinutes: reminderLeadSchema,
  businessProfile: businessProfileSchema.optional(),
});
export type OwnerSalonSettings = z.infer<typeof ownerSalonSettingsSchema>;

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

/** Slot grids the salon can pick from, in minutes. */
export const SLOT_GRANULARITIES = [5, 10, 15, 20, 30, 60];

const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    try {
      if (/^[A-Za-z]/.test(value)) {
        return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
      }
    } catch {
      // Report invalid identifiers through the shared request schema.
    }
    ctx.addIssue({ code: "custom", message: "Unknown IANA timezone" });
    return z.NEVER;
  });

/** Owner-only edit of the single salon settings row. Every field is optional. */
export const updateSalonSettingsRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: ianaTimeZoneSchema,
    /** Offered start times are multiples of this many minutes. */
    slotGranularityMinutes: z
      .number()
      .int()
      .refine((n) => SLOT_GRANULARITIES.includes(n), "Unsupported granularity"),
    minNoticeMinutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30),
    maxDaysAhead: z.number().int().min(1).max(365),
    onlineBookingEnabled: z.boolean(),
    reminderFirstLeadMinutes: reminderLeadSchema,
    reminderSecondLeadMinutes: reminderLeadSchema,
    businessProfile: businessProfileSchema
      .partial()
      .refine(
        (value) => Object.values(value).some((field) => field !== undefined),
        "Provide a profile change",
      ),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["name"],
  });
export type UpdateSalonSettingsRequest = z.infer<typeof updateSalonSettingsRequestSchema>;

export const reviewedSalonSettingsSchema = ownerSalonSettingsSchema
  .required({ onlineBookingEnabled: true })
  .extend({ revision: instantSchema });
export type ReviewedSalonSettings = z.infer<typeof reviewedSalonSettingsSchema>;

export const desktopSalonSettingsSchema = reviewedSalonSettingsSchema.extend({
  generation: syncGenerationSchema,
});

/** Native edits are conditional on the settings revision reviewed by the owner. */
export const reviewedSalonSettingsRequestSchema = z.strictObject({
  expectedRevision: instantSchema,
  changes: updateSalonSettingsRequestSchema,
});
