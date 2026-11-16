import { z } from "zod";
import { idSchema } from "./common";

const label = z.string().trim().min(1).max(80);
const allowed = z
  .array(idSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Eligible services must be unique",
  });
export const serviceCatalogCreateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("variant"), parentServiceId: idSchema, optionLabel: label }).strict(),
  z.object({ kind: z.literal("addon"), allowedServiceIds: allowed }).strict(),
]);
export type ServiceCatalogCreate = z.infer<typeof serviceCatalogCreateSchema>;
export const serviceCatalogUpdateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("variant"),
      version: z.number().int().positive(),
      optionLabel: label,
    })
    .strict(),
  z
    .object({
      kind: z.literal("addon"),
      version: z.number().int().positive(),
      allowedServiceIds: allowed,
    })
    .strict(),
]);
export type ServiceCatalogUpdate = z.infer<typeof serviceCatalogUpdateSchema>;
export const serviceCatalogSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("variant"),
    version: z.number().int().positive(),
    parentServiceId: idSchema,
    optionLabel: label,
  }),
  z.object({
    kind: z.literal("addon"),
    version: z.number().int().positive(),
    allowedServiceIds: allowed,
  }),
]);
export type ServiceCatalog = z.infer<typeof serviceCatalogSchema>;
