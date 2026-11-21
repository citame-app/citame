import { z } from "zod";
import { idSchema, instantSchema, syncGenerationSchema } from "./common";

const days = z.number().int().min(1).max(3650).nullable();
const stamps = z.number().int().min(0).max(15);
const version = z.number().int().positive();

export const stampProgramTermsSchema = z
  .object({
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(80),
    appearance: z.enum(["neutral", "rose", "mint"]),
    goal: stamps.min(1),
    welcomeStamps: stamps,
    qualifyingServiceIds: z.array(idSchema).max(50),
    minimumSpendCents: z.number().int().min(0).max(999_999_999),
    stampExpiryDays: days,
    expiryFrom: z.enum(["issue", "activity"]),
    rewardExpiryDays: days,
    automaticIssue: z.boolean(),
    awardOn: z.enum(["checkout", "appointment"]),
    terms: z.string().trim().max(2000),
    reward: z
      .object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(["service", "product", "other"]),
        targetId: idSchema.nullable(),
        discountBasisPoints: z.number().int().min(1).max(10000).nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((terms) => terms.welcomeStamps < terms.goal, {
    path: ["welcomeStamps"],
    message: "Welcome stamps must be below the reward goal",
  })
  .refine(
    (terms) => new Set(terms.qualifyingServiceIds).size === terms.qualifyingServiceIds.length,
    {
      path: ["qualifyingServiceIds"],
      message: "Qualifying services must be unique",
    },
  )
  .refine((terms) => terms.reward.kind !== "other" || terms.reward.targetId === null, {
    path: ["reward", "targetId"],
    message: "Only service or product rewards link to the catalogue",
  });
export type StampProgramTerms = z.infer<typeof stampProgramTermsSchema>;

export const stampProgramSchema = z.object({
  version,
  generation: syncGenerationSchema,
  program: stampProgramTermsSchema,
});
export const stampProgramInputSchema = stampProgramSchema
  .extend({ existingCards: z.enum(["keep", "void"]) })
  .strict();
export type StampProgramInput = z.infer<typeof stampProgramInputSchema>;

const command = {
  generation: syncGenerationSchema,
  idempotencyKey: idSchema,
};

export const issueStampCardSchema = z
  .object({
    ...command,
    clientId: idSchema,
    programVersion: version,
    initialStamps: stamps.optional(),
    expiresAt: instantSchema.nullable().optional(),
  })
  .strict();
export type IssueStampCard = z.infer<typeof issueStampCardSchema>;

const cardAction = { ...command, version };
export const changeStampCardSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...cardAction,
      type: z.literal("edit"),
      stamps,
      expiresAt: instantSchema.nullable(),
      reason: z.string().trim().min(8).max(300),
    })
    .strict(),
  z.object({ ...cardAction, type: z.literal("issue_reward") }).strict(),
  z.object({ ...cardAction, type: z.literal("redeem") }).strict(),
  z
    .object({ ...cardAction, type: z.literal("void"), reason: z.string().trim().min(8).max(300) })
    .strict(),
]);
export type ChangeStampCard = z.infer<typeof changeStampCardSchema>;

export const stampCardSchema = z.object({
  id: idSchema,
  version,
  programVersion: version,
  program: stampProgramTermsSchema,
  stamps,
  state: z.enum(["active", "completed", "issued", "redeemed", "expired", "void"]),
  needsReview: z.boolean(),
  createdAt: instantSchema,
  stampExpiresAt: instantSchema.nullable(),
  rewardExpiresAt: instantSchema.nullable(),
  completedAt: instantSchema.nullable(),
  rewardIssuedAt: instantSchema.nullable(),
  redeemedAt: instantSchema.nullable(),
});
export type StampCard = z.infer<typeof stampCardSchema>;

export const stampCardsSchema = z.object({ cards: z.array(stampCardSchema) });
export const adminStampCardsSchema = stampCardsSchema.extend({
  generation: syncGenerationSchema,
  programVersion: version,
  program: stampProgramTermsSchema,
});
