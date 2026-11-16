import { z } from "zod";
import { idSchema, instantSchema } from "./common";
export const CLIENT_IDENTITY_MAX_PROFILES = 20;
export const clientMergePairSchema = z
  .object({ sourceId: idSchema, targetId: idSchema })
  .strict()
  .refine((value) => value.sourceId !== value.targetId, {
    path: ["targetId"],
    message: "Choose two different profiles",
  });
export const clientMergeInputSchema = clientMergePairSchema.safeExtend({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedSamePerson: z.literal(true),
  idempotencyKey: idSchema,
});
export const clientMergeReasonSchema = z.enum([
  "source_account",
  "source_merged",
  "target_merged",
  "group_limit",
  "photo_limit",
  "tag_limit",
]);
export const clientMergeProfileSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  bookingAccess: z.enum(["normal", "trusted", "blocked"]),
  hasAccount: z.boolean(),
  profileCount: z.number().int().positive(),
});
export const clientMergePreviewSchema = z.object({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  canMerge: z.boolean(),
  reasons: z.array(clientMergeReasonSchema),
  source: clientMergeProfileSchema,
  target: clientMergeProfileSchema,
  counts: z.object({
    profiles: z.number().int().nonnegative(),
    appointments: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
    forms: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    gifts: z.number().int().nonnegative(),
  }),
});
export const clientMergeSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  createdAt: instantSchema,
});
export type ClientMergePair = z.infer<typeof clientMergePairSchema>;
export type ClientMergeInput = z.infer<typeof clientMergeInputSchema>;
export type ClientMergePreview = z.infer<typeof clientMergePreviewSchema>;
export type ClientMerge = z.infer<typeof clientMergeSchema>;

export const clientDuplicatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        id: idSchema,
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        hasAccount: z.boolean(),
        matchedBy: z.array(z.enum(["email", "phone", "name"])),
      }),
    )
    .max(20),
  hasMore: z.boolean(),
});
export type ClientDuplicates = z.infer<typeof clientDuplicatesSchema>;
