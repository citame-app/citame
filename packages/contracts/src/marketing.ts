import { z } from "zod";
import { clientTagsSchema } from "./client-controls";
import { idSchema, instantSchema, pageInfoSchema } from "./common";

export const marketingChannelSchema = z.enum(["email", "sms", "optimized"]);
export const marketingTriggerSchema = z.enum(["manual", "first_visit", "inactive", "birthday"]);
export const campaignStatusSchema = z.enum([
  "draft",
  "scheduled",
  "active",
  "completed",
  "cancelled",
]);
export const campaignAudienceSchema = z
  .object({
    tags: clientTagsSchema.default([]),
    inactiveDays: z.number().int().min(1).max(3650).nullable().default(null),
    noFutureAppointments: z.boolean().default(false),
  })
  .strict();
const campaignFields = {
  name: z.string().trim().min(1).max(160),
  channel: marketingChannelSchema,
  subject: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\r\n]*$/),
  emailBody: z.string().trim().max(10000),
  smsBody: z.string().trim().max(304),
  audience: campaignAudienceSchema,
  trigger: marketingTriggerSchema,
  delayMinutes: z.number().int().min(0).max(525600),
  birthdayLeadDays: z.number().int().min(0).max(30),
};
export const campaignDraftSchema = z.object(campaignFields).strict();
export const campaignCreateSchema = campaignDraftSchema.extend({ id: idSchema }).strict();
export const campaignUpdateSchema = campaignDraftSchema
  .extend({ version: z.number().int().positive() })
  .strict();
export const campaignQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(""),
  status: campaignStatusSchema.optional(),
});
export const campaignCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export const campaignSchema = campaignDraftSchema.extend({
  id: idSchema,
  status: campaignStatusSchema,
  version: z.number().int().positive(),
  scheduledFor: instantSchema.nullable(),
  activatedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  counts: campaignCountsSchema,
});
export const campaignListSchema = z.object({
  campaigns: z.array(campaignSchema),
  pagination: pageInfoSchema,
});
export const campaignCapabilitySchema = z.object({
  email: z.boolean(),
  sms: z.boolean(),
  worker: z.boolean(),
  canTestEmail: z.boolean().optional(),
});
export const campaignPreviewSchema = z.object({
  campaignId: idSchema,
  version: z.number().int().positive(),
  audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
  eligible: z.number().int().nonnegative(),
  email: z.number().int().nonnegative(),
  sms: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  sample: z
    .array(z.object({ clientId: idSchema, name: z.string(), channel: z.enum(["email", "sms"]) }))
    .max(10),
});
export const campaignQueueSchema = z
  .object({
    version: z.number().int().positive(),
    audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
    scheduledFor: instantSchema.nullable(),
  })
  .strict();
export const campaignCancelSchema = z.object({ version: z.number().int().positive() }).strict();
export const campaignTestEmailSchema = z.strictObject({
  version: z.number().int().positive(),
  requestId: idSchema,
  mode: z.enum(["send", "check", "replace_unconfirmed"]).default("send"),
});
export const campaignTestEmailReceiptSchema = z.object({
  status: z.enum(["accepted", "pending", "unconfirmed", "rejected", "not_requested"]),
  requestId: idSchema,
});
export type CampaignTestEmail = z.infer<typeof campaignTestEmailSchema>;
export type CampaignTestEmailReceipt = z.infer<typeof campaignTestEmailReceiptSchema>;
export const marketingConsentSchema = z.object({
  clientId: idSchema,
  email: z.object({
    enabled: z.boolean(),
    version: z.number().int().nonnegative(),
    source: z.string().nullable(),
    updatedAt: instantSchema.nullable(),
  }),
  sms: z.object({
    enabled: z.boolean(),
    version: z.number().int().nonnegative(),
    source: z.string().nullable(),
    updatedAt: instantSchema.nullable(),
  }),
});
export const marketingConsentInputSchema = z
  .object({
    channel: z.enum(["email", "sms"]),
    enabled: z.boolean(),
    version: z.number().int().nonnegative(),
    source: z.string().trim().min(3).max(500),
  })
  .strict();
export const campaignDeliverySchema = z.object({
  id: idSchema,
  clientId: idSchema,
  clientName: z.string(),
  channel: z.enum(["email", "sms"]),
  status: z.enum(["pending", "processing", "sent", "skipped", "failed", "unknown", "cancelled"]),
  reason: z.string().nullable(),
  createdAt: instantSchema,
  sentAt: instantSchema.nullable(),
});
export const campaignDeliveriesSchema = z.object({
  deliveries: z.array(campaignDeliverySchema),
  pagination: pageInfoSchema,
});
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;
export type CampaignCreate = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignQuery = z.infer<typeof campaignQuerySchema>;
export type CampaignQueue = z.infer<typeof campaignQueueSchema>;
export type MarketingConsentInput = z.infer<typeof marketingConsentInputSchema>;
