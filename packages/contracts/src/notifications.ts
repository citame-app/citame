import { z } from "zod";

export const NOTIFICATION_LOCALES = ["en", "es-AR"] as const;
export const notificationLocaleSchema = z.enum(NOTIFICATION_LOCALES);
export type NotificationLocale = z.infer<typeof notificationLocaleSchema>;

const categoryPrefsSchema = z.object({
  /** Confirmation, cancellation and reschedule notices of bookings the client made. */
  transactional: z.boolean(),
  /** Time-based reminders ahead of the appointment. */
  reminder: z.boolean(),
});

/** What the signed-in client chose (or the defaults when they never did). */
export const notificationPreferencesSchema = z.object({
  /** Language of messages; null means the salon default. */
  locale: notificationLocaleSchema.nullable(),
  email: categoryPrefsSchema,
  /** SMS is off by default: turning it on is the client's consent to be texted. */
  sms: categoryPrefsSchema,
  /** Whether messages could reach the client at all. */
  hasEmail: z.boolean(),
  hasPhone: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesRequestSchema = z
  .object({
    locale: notificationLocaleSchema.nullable(),
    email: categoryPrefsSchema.partial(),
    sms: categoryPrefsSchema.partial(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["email"],
  });
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;

/** What an opt-out link does, shown before the visitor confirms. */
export const optOutPreviewSchema = z.object({
  channel: z.enum(["email", "sms"]),
  category: z.literal("reminder"),
  /** True when the reminders are already off. */
  optedOut: z.boolean(),
});
export type OptOutPreview = z.infer<typeof optOutPreviewSchema>;

export const optOutRequestSchema = z.object({ token: z.string().min(10).max(1000) });
export type OptOutRequest = z.infer<typeof optOutRequestSchema>;

/** Owner-only reminder timing, part of the salon settings. */
export const reminderLeadSchema = z
  .number()
  .int()
  .min(5)
  .max(60 * 24 * 14)
  .nullable();

export const notificationStatsSchema = z.object({
  queue: z.record(z.string(), z.number().int()),
  accountEmails: z.record(z.string(), z.number().int()),
  worker: z.record(z.string(), z.number().int()),
  channels: z.object({ email: z.boolean(), sms: z.boolean() }),
});
export type NotificationStats = z.infer<typeof notificationStatsSchema>;
