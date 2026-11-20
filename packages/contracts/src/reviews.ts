import { z } from "zod";
import { idSchema, instantSchema } from "./common";
import { campaignDeliverySchema } from "./marketing";

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes before PostgreSQL text writes.
    .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u, "Unsupported control characters");
export const reviewStatusSchema = z.enum(["pending", "published", "hidden", "withdrawn"]);
export const REVIEW_SOCIAL_PERMISSION_VERSION = "public-review-social-v1";
const content = {
  publicName: text(80),
  rating: z.number().int().min(1).max(5),
  body: text(2000),
  shareServices: z.boolean().default(false),
  allowSocialUse: z.boolean().default(false),
  publicationConfirmed: z.literal(true),
};
export const reviewCreateSchema = z
  .object({ appointmentId: idSchema, idempotencyKey: idSchema, ...content })
  .strict();
export const reviewEditSchema = z
  .object({ version: z.number().int().positive(), ...content })
  .strict();
export const reviewVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const reviewModerationSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(["published", "hidden"]),
    reason: text(300).optional(),
  })
  .strict()
  .refine((value) => value.status !== "hidden" || !!value.reason, {
    message: "Explain why this review is hidden",
    path: ["reason"],
  });
export const reviewReplySchema = z
  .object({ version: z.number().int().positive(), reply: text(1000).nullable() })
  .strict();
const paging = {
  before: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
};
export const reviewPublicQuerySchema = z
  .object({ ...paging, serviceId: idSchema.optional() })
  .strict();
export const reviewPrivateQuerySchema = z
  .object({ ...paging, appointmentId: idSchema.optional() })
  .strict();
export const reviewAdminQuerySchema = z
  .object({ ...paging, status: reviewStatusSchema.optional() })
  .strict();
export const reviewServicesSchema = z
  .array(z.object({ id: idSchema.nullable(), name: z.string() }))
  .max(24);
export const reviewPublicSchema = z.object({
  id: idSchema,
  publicName: text(80),
  rating: z.number().int().min(1).max(5),
  body: text(2000),
  services: reviewServicesSchema,
  reply: text(1000).nullable(),
  publishedAt: instantSchema,
});
export const reviewSocialSchema = reviewPublicSchema.extend({
  permissionVersion: z.literal(REVIEW_SOCIAL_PERMISSION_VERSION),
  reviewVersion: z.number().int().positive(),
});
export const publicReviewsSchema = z.object({
  reviews: z.array(reviewPublicSchema),
  nextBefore: idSchema.nullable(),
  total: z.number().int().nonnegative(),
  average: z.number().min(1).max(5).nullable(),
});
export const reviewPrivateSchema = z.object({
  id: idSchema,
  appointmentId: idSchema,
  publicName: text(80).nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  body: text(2000).nullable(),
  shareServices: z.boolean(),
  allowSocialUse: z.boolean().default(false),
  socialPermissionVersion: z.literal(REVIEW_SOCIAL_PERMISSION_VERSION).nullable().default(null),
  services: reviewServicesSchema,
  status: reviewStatusSchema,
  moderationReason: text(300).nullable(),
  reply: text(1000).nullable(),
  version: z.number().int().positive(),
  sourceEligible: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const ownReviewsSchema = z.object({
  visits: z.array(
    z.object({
      appointmentId: idSchema,
      startsAt: instantSchema,
      services: reviewServicesSchema,
      review: reviewPrivateSchema.nullable(),
    }),
  ),
  nextBefore: idSchema.nullable(),
});
export const adminReviewsSchema = z.object({
  reviews: z.array(reviewPrivateSchema),
  nextBefore: idSchema.nullable(),
});
export const REVIEW_REQUEST_MAX_PAGE = 10000;
export const REVIEW_REQUEST_SEARCH_LENGTH = 100;
export const reviewRequestQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(REVIEW_REQUEST_MAX_PAGE).default(1),
    search: z.string().trim().max(REVIEW_REQUEST_SEARCH_LENGTH).default(""),
  })
  .strict();
export const reviewEmailStatusSchema = campaignDeliverySchema.shape.status;
export const reviewEmailRequestSchema = z.object({ status: reviewEmailStatusSchema });
export const reviewRequestsSchema = z.object({
  visits: z.array(
    z.object({
      appointmentId: idSchema,
      startsAt: instantSchema,
      clientName: z.string(),
      link: z.url({ protocol: /^https?$/ }).nullable(),
      canEmail: z.boolean().default(false),
      emailStatus: reviewEmailStatusSchema.nullable().default(null),
    }),
  ),
  hasMore: z.boolean(),
  emailEnabled: z.boolean().default(false),
});
export type ReviewCreate = z.infer<typeof reviewCreateSchema>;
export type ReviewEdit = z.infer<typeof reviewEditSchema>;
export type ReviewModeration = z.infer<typeof reviewModerationSchema>;
export type ReviewPublic = z.infer<typeof reviewPublicSchema>;
export type ReviewPrivate = z.infer<typeof reviewPrivateSchema>;
export type ReviewSocial = z.infer<typeof reviewSocialSchema>;
export type ReviewRequestQuery = z.infer<typeof reviewRequestQuerySchema>;
