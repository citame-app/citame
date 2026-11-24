import { z } from "zod";
import { instantSchema, localDateSchema, syncGenerationSchema } from "./common";
import { dateShiftRangesSchema } from "./date-shifts";
import { reminderLeadSchema } from "./notifications";
import { publicProfileImagesSchema } from "./salon-media";

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
export const OPENING_EXCEPTION_LIMIT = 366;
const openingRanges = dateShiftRangesSchema.transform((ranges) =>
  [...ranges].sort((a, b) => a.startTime.localeCompare(b.startTime)),
);
export const openingScheduleSchema = z.strictObject({
  /** Sunday first. Null means a regular schedule has not been configured. */
  weekly: z.array(openingRanges).length(7).nullable(),
  exceptions: z
    .array(z.strictObject({ date: localDateSchema, ranges: openingRanges }))
    .max(OPENING_EXCEPTION_LIMIT)
    .refine(
      (entries) => new Set(entries.map(({ date }) => date)).size === entries.length,
      "Provide only one opening-hours exception per date",
    )
    .transform((entries) => [...entries].sort((a, b) => a.date.localeCompare(b.date))),
});
export type OpeningSchedule = z.infer<typeof openingScheduleSchema>;
export const EMPTY_OPENING_SCHEDULE: OpeningSchedule = {
  weekly: null,
  exceptions: [],
};
const weekdayKey = z.enum(["0", "1", "2", "3", "4", "5", "6"]);
const openingScheduleEditsSchema = z
  .strictObject({
    weeklyEnabled: z.boolean().optional(),
    days: z.partialRecord(weekdayKey, openingRanges).optional(),
    exceptions: z.record(localDateSchema, openingRanges.nullable()).optional(),
  })
  .refine(
    (edit) =>
      Object.keys(edit.exceptions ?? {}).length <= 2 * OPENING_EXCEPTION_LIMIT &&
      (edit.weeklyEnabled !== undefined ||
        Object.keys(edit.days ?? {}).length > 0 ||
        Object.keys(edit.exceptions ?? {}).length > 0) &&
      (edit.weeklyEnabled !== false || Object.keys(edit.days ?? {}).length === 0),
    "Provide valid opening-hours changes",
  );
export type OpeningScheduleEdits = z.infer<typeof openingScheduleEditsSchema>;

export function diffOpeningSchedule(
  base: OpeningSchedule,
  next: OpeningSchedule,
): OpeningScheduleEdits | undefined {
  const edit: OpeningScheduleEdits = {};
  if (Boolean(base.weekly) !== Boolean(next.weekly)) edit.weeklyEnabled = Boolean(next.weekly);
  for (const day of weekdayKey.options) {
    const ranges = next.weekly?.[Number(day)];
    if (ranges && JSON.stringify(ranges) !== JSON.stringify(base.weekly?.[Number(day)] ?? [])) {
      edit.days ??= {};
      edit.days[day] = ranges;
    }
  }
  const previous = new Map(base.exceptions.map(({ date, ranges }) => [date, ranges]));
  for (const { date, ranges } of next.exceptions) {
    if (JSON.stringify(previous.get(date)) !== JSON.stringify(ranges)) {
      edit.exceptions ??= {};
      edit.exceptions[date] = ranges;
    }
    previous.delete(date);
  }
  for (const date of previous.keys()) {
    edit.exceptions ??= {};
    edit.exceptions[date] = null;
  }
  return Object.keys(edit).length ? edit : undefined;
}

export function applyOpeningScheduleEdits(
  base: OpeningSchedule,
  edit: OpeningScheduleEdits,
): OpeningSchedule {
  const exceptions = new Map(base.exceptions.map(({ date, ranges }) => [date, ranges]));
  for (const [date, ranges] of Object.entries(edit.exceptions ?? {})) {
    if (ranges === null) exceptions.delete(date);
    else exceptions.set(date, ranges);
  }
  return {
    weekly:
      edit.weeklyEnabled !== false && (edit.weeklyEnabled || base.weekly || edit.days)
        ? weekdayKey.options.map((day) => edit.days?.[day] ?? base.weekly?.[Number(day)] ?? [])
        : null,
    exceptions: [...exceptions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ranges]) => ({ date, ranges })),
  };
}
export const BUSINESS_DESCRIPTION_MAX_LENGTH = 2_000;
const BUSINESS_DESCRIPTION_MAX_LINES = 64;
const businessDescription = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .pipe(
    z
      .string()
      .max(BUSINESS_DESCRIPTION_MAX_LENGTH)
      .refine((value) => value.split("\n").length <= BUSINESS_DESCRIPTION_MAX_LINES)
      .refine((value) => !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value.replaceAll("\n", ""))),
  )
  .transform((value) => value.trim() || null)
  .nullable();

export const businessProfileContentSchema = z.strictObject({
  description: businessDescription,
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
  openingSchedule: openingScheduleSchema.optional(),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export const publicBusinessProfileSchema = z.object({
  profile: businessProfileContentSchema.nullable(),
  openingSchedule: openingScheduleSchema.optional(),
  images: publicProfileImagesSchema.optional(),
});
export type PublicBusinessProfile = NonNullable<
  z.infer<typeof publicBusinessProfileSchema>["profile"]
>;
export const businessProfileChangesSchema = businessProfileSchema
  .partial()
  .extend({ openingScheduleEdits: openingScheduleEditsSchema.optional() })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Provide a profile change",
  )
  .refine(
    (value) => !(value.openingSchedule && value.openingScheduleEdits),
    "Provide either opening hours or individual changes",
  );
export type BusinessProfileChanges = z.infer<typeof businessProfileChangesSchema>;
export const reviewedBusinessProfileRequestSchema = z.strictObject({
  generation: syncGenerationSchema,
  expectedRevision: instantSchema,
  changes: businessProfileChangesSchema,
});
export type ReviewedBusinessProfileRequest = z.infer<typeof reviewedBusinessProfileRequestSchema>;
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
  openingSchedule: EMPTY_OPENING_SCHEDULE,
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
});
export type SalonResponse = z.infer<typeof salonResponseSchema>;

/** What the owner sees and edits: the public fields plus reminder timing. */
export const ownerSalonSettingsSchema = salonResponseSchema.extend({
  /** Minutes before the start for the first reminder (default 1440 = 24 h); null turns it off. */
  reminderFirstLeadMinutes: reminderLeadSchema,
  /** Minutes before the start for the second reminder (default 120 = 2 h); null turns it off. */
  reminderSecondLeadMinutes: reminderLeadSchema,
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

const salonSettingsChanges = z.object({
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
});
const hasChange = (value: object) => Object.values(value).some((field) => field !== undefined);
const missingChange = { message: "Provide at least one change", path: ["name"] };

/** Legacy edits can change operational settings. Private profile writes require review. */
export const updateSalonSettingsRequestSchema = salonSettingsChanges
  .partial()
  .refine(hasChange, missingChange);
export type UpdateSalonSettingsRequest = z.infer<typeof updateSalonSettingsRequestSchema>;

const reviewedSalonChangesSchema = salonSettingsChanges
  .extend({ businessProfile: businessProfileChangesSchema })
  .partial()
  .refine(hasChange, missingChange);
export type ReviewedSalonChanges = z.infer<typeof reviewedSalonChangesSchema>;

export const reviewedSalonSettingsSchema = ownerSalonSettingsSchema
  .required({ onlineBookingEnabled: true })
  .extend({
    revision: instantSchema,
    businessProfile: businessProfileSchema.omit({ openingSchedule: true }).optional(),
    openingSchedule: openingScheduleSchema.optional(),
  });
export type ReviewedSalonSettings = z.infer<typeof reviewedSalonSettingsSchema>;

export const desktopSalonSettingsSchema = reviewedSalonSettingsSchema.extend({
  generation: syncGenerationSchema,
});

/** Native edits are conditional on the settings revision reviewed by the owner. */
export const reviewedSalonSettingsRequestSchema = z.strictObject({
  expectedRevision: instantSchema,
  changes: reviewedSalonChangesSchema,
});
