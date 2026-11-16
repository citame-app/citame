import { z } from "zod";
import { idSchema, instantSchema } from "./common";

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
export const combinationCreateSchema = z.object({ ...fields, idempotencyKey: idSchema }).strict();
export const combinationUpdateSchema = z
  .object({ ...fields, version: z.number().int().positive() })
  .strict();
export const serviceCombinationSchema = z.object({
  id: idSchema,
  ...fields,
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
