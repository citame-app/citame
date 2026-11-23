import { z } from "zod";
import { idSchema, instantSchema } from "./common";

export const fixedCombinationReviewSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive(),
    reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FixedCombinationReview = z.infer<typeof fixedCombinationReviewSchema>;

export const fixedCombinationTermsSchema = z
  .object({
    onlineBooking: z.boolean().optional(),
    pricesCents: z.array(z.number().int().min(0).max(999_999_999)).min(2).max(24),
    staffIds: z
      .array(idSchema)
      .min(1)
      .max(100)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
        "Choose unique professionals",
      ),
  })
  .strict();
export type FixedCombinationTerms = z.infer<typeof fixedCombinationTermsSchema>;

const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\p{Cc}]+$/u),
  description: z
    .string()
    .trim()
    .max(1000)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: PostgreSQL text cannot contain NUL; reject other unsupported control bytes too.
    .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u)
    .nullable(),
  serviceIds: z
    .array(idSchema)
    .min(2)
    .max(24)
    .refine((ids) => new Set(ids).size === ids.length, "Choose unique services"),
  active: z.boolean(),
};
const writeFields = { ...fields, fixedTerms: fixedCombinationTermsSchema.nullable().optional() };
export const combinationCreateSchema = z
  .object({ ...writeFields, idempotencyKey: idSchema })
  .strict();
export const combinationUpdateSchema = z
  .object({ ...writeFields, version: z.number().int().positive() })
  .strict();
export const serviceCombinationSchema = z.object({
  id: idSchema,
  ...fields,
  fixedTerms: fixedCombinationTermsSchema.optional(),
  version: z.number().int().positive(),
  bookable: z.boolean(),
  updatedAt: instantSchema,
});
export const serviceCombinationsSchema = z.object({
  combinations: z.array(serviceCombinationSchema).max(100),
});
export type ServiceCombination = z.infer<typeof serviceCombinationSchema>;
export type CombinationCreate = z.infer<typeof combinationCreateSchema>;
export type CombinationUpdate = z.infer<typeof combinationUpdateSchema>;

export const listCombinationsSchema = serviceCombinationsSchema;
export const combinationListQuerySchema = z.object({ fixedTerms: z.literal("1").optional() });
