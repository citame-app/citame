import { z } from "zod";
import { idSchema, instantSchema, pageInfoSchema, pageSchema } from "./common";

export const calendarNoticeKindSchema = z.enum(["new", "rescheduled", "cancelled"]);
export const calendarNoticeSchema = z.object({
  id: idSchema,
  kind: calendarNoticeKindSchema,
  createdAt: instantSchema,
  appointmentId: idSchema,
  staffId: idSchema,
  startsAt: instantSchema,
  appointmentStartsAt: instantSchema,
  clientName: z.string(),
  serviceNames: z.array(z.string()),
});
export type CalendarNotice = z.infer<typeof calendarNoticeSchema>;
export const calendarInboxSchema = pageInfoSchema.extend({
  entries: z.array(calendarNoticeSchema),
});
export const calendarInboxQuerySchema = z.object({
  page: pageSchema.optional(),
  archived: z.enum(["true", "false"]).optional(),
  kind: calendarNoticeKindSchema.optional(),
});
export type CalendarInboxQuery = z.infer<typeof calendarInboxQuerySchema>;
export const calendarArchiveInputSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(50),
    archived: z.boolean(),
  })
  .strict();

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
  whatsapp: categoryPrefsSchema.optional(),
  hasWhatsAppPhone: z.boolean().optional(),
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
    whatsapp: categoryPrefsSchema.partial(),
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
  channel: z.enum(["email", "sms", "whatsapp"]),
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

export const whatsappKindSchema = z.enum([
  "confirmation",
  "reminder_24h",
  "reminder_2h",
  "rescheduled",
  "cancellation",
]);
export const whatsappVariableSchema = z.enum([
  "client",
  "salon",
  "date",
  "time",
  "staff",
  "services",
  "preferences",
]);
export const whatsappRuleSchema = z
  .object({
    kind: whatsappKindSchema,
    templateId: z.string().regex(/^\d{5,32}$/),
    variables: z.array(whatsappVariableSchema).max(20),
  })
  .strict();
export const whatsappRulesSchema = z
  .array(whatsappRuleSchema)
  .max(5)
  .refine(
    (rules) => new Set(rules.map(({ kind }) => kind)).size === rules.length,
    "Choose one WhatsApp template per event",
  );
const whatsappRevision = z.string().regex(/^[a-f0-9]{64}$/);
export const whatsappReviewedDisconnectSchema = z.strictObject({ revision: whatsappRevision });
export type WhatsAppReviewedDisconnect = z.infer<typeof whatsappReviewedDisconnectSchema>;
export const whatsappReviewedRulesSchema = z.strictObject({
  revision: whatsappRevision,
  rules: whatsappRulesSchema,
});
export type WhatsAppReviewedRules = z.infer<typeof whatsappReviewedRulesSchema>;
export const whatsappCompleteSchema = z
  .object({
    code: z.string().min(8).max(4096),
    wabaId: z.string().regex(/^\d{5,32}$/),
    phoneId: z
      .string()
      .regex(/^\d{5,32}$/)
      .optional(),
    pin: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export type WhatsAppConnectInput = z.infer<typeof whatsappCompleteSchema>;
export const whatsappReviewedConnectSchema = whatsappCompleteSchema.extend({
  revision: whatsappRevision,
});
export type WhatsAppReviewedConnect = z.infer<typeof whatsappReviewedConnectSchema>;
export const whatsappTemplateSchema = z.object({
  id: z.string().regex(/^\d{5,32}$/),
  name: z.string(),
  language: z.string(),
  body: z.string(),
  parameters: z.array(z.string()).max(20),
  named: z.boolean(),
});
export const whatsappSettingsSchema = z.object({
  signupRevision: whatsappRevision.optional(),
  setup: z.object({ appId: z.string(), configId: z.string(), version: z.string() }).nullable(),
  connection: z
    .object({
      phone: z.string(),
      revision: whatsappRevision.optional(),
      coexistence: z.boolean(),
      rules: whatsappRulesSchema,
      expiresAt: instantSchema.nullable(),
    })
    .nullable(),
});
export type WhatsAppSettings = z.infer<typeof whatsappSettingsSchema>;
export type WhatsAppRule = z.infer<typeof whatsappRuleSchema>;
export type WhatsAppTemplate = z.infer<typeof whatsappTemplateSchema>;

export const whatsappDeliveriesSchema = z.array(
  z.object({
    id: idSchema,
    kind: whatsappKindSchema,
    scheduledFor: instantSchema,
    status: z.enum(["pending", "processing", "sent", "skipped", "cancelled", "failed"]),
    delivery: z.enum(["sent", "delivered", "read", "failed"]).nullable(),
    lastError: z.string().nullable(),
  }),
);

export const whatsappDeskSchema = z.object({
  configured: z.boolean(),
  connection: whatsappSettingsSchema.shape.connection
    .unwrap()
    .extend({
      revision: whatsappRevision,
      rules: z.array(whatsappRuleSchema.extend({ templateName: z.string(), language: z.string() })),
    })
    .nullable(),
  deliveries: z.array(
    whatsappDeliveriesSchema.element.omit({ lastError: true }).extend({ uncertain: z.boolean() }),
  ),
});
