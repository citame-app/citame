import { z } from "zod";
import { clientTagsSchema } from "./client-controls";
import { rasterImageBase64Schema } from "./client-photos";
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
export const BOOKING_INVITATION_MAX_CONTACTS = 100;
export const CAMPAIGN_EMAIL_LIMITS = {
  heading: 140,
  preheader: 150,
  imageAlt: 180,
  bookingLabel: 80,
  blocks: 16,
  paragraphLines: 256,
  body: 10000,
} as const;

const layoutText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes("\0"), "Text cannot contain NUL");
const layoutLine = (max: number, min = 0) =>
  layoutText(max, min).refine((value) => !/[\r\n]/.test(value), "Enter a single line");
const campaignEmailLayoutFields = z.strictObject({
  heading: layoutLine(CAMPAIGN_EMAIL_LIMITS.heading).default(""),
  preheader: layoutLine(CAMPAIGN_EMAIL_LIMITS.preheader).default(""),
  headerImage: z
    .strictObject({
      imageBase64: rasterImageBase64Schema,
      alt: layoutLine(CAMPAIGN_EMAIL_LIMITS.imageAlt, 1),
    })
    .nullable()
    .optional(),
  blocks: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("heading"),
          text: layoutLine(CAMPAIGN_EMAIL_LIMITS.heading, 1),
        }),
        z.strictObject({
          kind: z.literal("paragraph"),
          text: layoutText(CAMPAIGN_EMAIL_LIMITS.body, 1)
            .transform((value) => value.replace(/\r\n?/g, "\n"))
            .refine(
              (value) => value.split("\n").length <= CAMPAIGN_EMAIL_LIMITS.paragraphLines,
              "Split long messages into paragraphs of at most 256 lines",
            ),
          emphasis: z.enum(["none", "strong", "italic"]),
        }),
        z.strictObject({
          kind: z.literal("booking"),
          label: layoutLine(CAMPAIGN_EMAIL_LIMITS.bookingLabel, 1),
        }),
      ]),
    )
    .min(1)
    .max(CAMPAIGN_EMAIL_LIMITS.blocks),
});
export type CampaignEmailLayout = z.infer<typeof campaignEmailLayoutFields>;

export function campaignEmailLayoutText(layout: CampaignEmailLayout): string {
  return [
    layout.heading,
    layout.preheader,
    ...layout.blocks.map((block) =>
      block.kind === "booking" ? `${block.label}: {{booking_url}}` : block.text,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function campaignEmailHasBookingLink(
  body: string,
  layout?: CampaignEmailLayout | null,
): boolean {
  const hasLink = (text: string) => text.includes("{{booking_url}}");
  return layout
    ? hasLink(layout.heading) ||
        layout.blocks.some((block) => block.kind === "booking" || hasLink(block.text))
    : hasLink(body);
}

export const campaignEmailLayoutSchema = campaignEmailLayoutFields.refine(
  (layout) => campaignEmailLayoutText(layout).length <= CAMPAIGN_EMAIL_LIMITS.body,
  "Email layout exceeds the message limit",
);

export const campaignAudienceSchema = z
  .object({
    tags: clientTagsSchema.default([]),
    inactiveDays: z.number().int().min(1).max(3650).nullable().default(null),
    noFutureAppointments: z.boolean().default(false),
    selectedClientIds: z
      .array(idSchema)
      .min(1)
      .max(BOOKING_INVITATION_MAX_CONTACTS)
      .transform((ids) => ids.map((id) => id.toLowerCase()))
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Clients must be selected once",
      })
      .optional(),
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
  emailBody: z.string().trim().max(CAMPAIGN_EMAIL_LIMITS.body),
  emailLayout: campaignEmailLayoutSchema.nullable().optional(),
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
export const campaignDetailQuerySchema = z.object({
  emailLayout: z.literal("1").optional(),
  headerImages: z.literal("1").optional(),
});
export const campaignQuerySchema = campaignDetailQuerySchema.extend({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(""),
  status: campaignStatusSchema.optional(),
  bookingInvitations: z.literal("1").optional(),
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
  hasHeaderImage: z.literal(true).optional(),
  id: idSchema,
  status: campaignStatusSchema,
  version: z.number().int().positive(),
  scheduledFor: instantSchema.nullable(),
  activatedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  counts: campaignCountsSchema,
  selectedContacts: z.array(z.object({ id: idSchema, name: z.string() })).optional(),
});
export const CAMPAIGN_COMPARISON_MAX = 4;
export const campaignComparisonQuerySchema = z.object({
  ids: z
    .string()
    .max(CAMPAIGN_COMPARISON_MAX * 37 - 1)
    .transform((value) => value.toLowerCase().split(","))
    .pipe(z.array(idSchema).min(2).max(CAMPAIGN_COMPARISON_MAX))
    .refine((ids) => new Set(ids).size === ids.length),
});
export const campaignComparisonSchema = z.object({
  campaigns: z.array(
    campaignSchema.pick({ id: true, name: true, channel: true, status: true, counts: true }),
  ),
});
export const campaignListSchema = z.object({
  campaigns: z.array(campaignSchema),
  pagination: pageInfoSchema,
  bookingInvitations: z.boolean().optional(),
});
export const campaignCapabilitySchema = z.object({
  email: z.boolean(),
  sms: z.boolean(),
  worker: z.boolean(),
  canTestEmail: z.boolean().optional(),
});
const campaignSmsTestReviewSchema = z.object({
  lastFour: z.string().regex(/^\d{4}$/),
  message: z.string(),
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().min(1),
});
export type CampaignSmsTestReview = z.infer<typeof campaignSmsTestReviewSchema>;
export const campaignPreviewSchema = z.object({
  campaignId: idSchema,
  version: z.number().int().positive(),
  audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
  eligible: z.number().int().nonnegative(),
  email: z.number().int().nonnegative(),
  sms: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  smsTest: campaignSmsTestReviewSchema.optional(),
  sample: z
    .array(z.object({ clientId: idSchema, name: z.string(), channel: z.enum(["email", "sms"]) }))
    .max(BOOKING_INVITATION_MAX_CONTACTS),
});
export const campaignQueueSchema = z
  .object({
    version: z.number().int().positive(),
    audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
    scheduledFor: instantSchema.nullable(),
  })
  .strict();
export const campaignCancelSchema = z.object({ version: z.number().int().positive() }).strict();
export const campaignTestRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  requestId: idSchema,
  mode: z.enum(["send", "check", "replace_unconfirmed"]).default("send"),
});
export const campaignTestReceiptSchema = z.object({
  status: z.enum(["accepted", "pending", "unconfirmed", "rejected", "not_requested"]),
  requestId: idSchema,
});
export const campaignTestSmsSchema = campaignTestRequestSchema
  .extend({
    reviewToken: campaignSmsTestReviewSchema.shape.reviewToken,
    replacesRequestId: idSchema.optional(),
  })
  .refine(
    ({ mode, replacesRequestId }) =>
      (mode === "replace_unconfirmed") === Boolean(replacesRequestId),
    {
      path: ["replacesRequestId"],
      message: "Identify the unconfirmed test when replacing it",
    },
  );
export type CampaignTestRequest = z.infer<typeof campaignTestRequestSchema>;
export type CampaignTestSms = z.infer<typeof campaignTestSmsSchema>;
export type CampaignTestReceipt = z.infer<typeof campaignTestReceiptSchema>;
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
export type CampaignDetailQuery = z.infer<typeof campaignDetailQuerySchema>;
export type CampaignQueue = z.infer<typeof campaignQueueSchema>;
export type MarketingConsentInput = z.infer<typeof marketingConsentInputSchema>;
