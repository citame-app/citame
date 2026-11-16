import { z } from "zod";
import { idSchema, instantSchema } from "./common";
export const resourceKindSchema = z.enum(["room", "equipment", "station", "other"]);
const fields = {
  name: z.string().trim().min(1).max(80),
  kind: resourceKindSchema,
  capacity: z.number().int().min(1).max(20),
};
export const resourceCreateSchema = z
  .object({ ...fields, idempotencyKey: z.string().min(8).max(120) })
  .strict();
export type ResourceCreate = z.infer<typeof resourceCreateSchema>;
export const resourceUpdateSchema = z
  .object({ ...fields, active: z.boolean(), version: z.number().int().positive() })
  .strict();
export type ResourceUpdate = z.infer<typeof resourceUpdateSchema>;
export const resourceSchema = z.object({
  ...fields,
  id: idSchema,
  active: z.boolean(),
  version: z.number().int().positive(),
  createdAt: instantSchema,
});
export type Resource = z.infer<typeof resourceSchema>;
export const resourceListSchema = z.object({ resources: z.array(resourceSchema) });
export const resourceRequirementSchema = z
  .object({ resourceId: idSchema, quantity: z.number().int().min(1).max(20) })
  .strict();
export const serviceResourceInputSchema = z
  .object({
    version: z.number().int().positive(),
    requirements: z
      .array(resourceRequirementSchema)
      .max(8)
      .refine((rows) => new Set(rows.map((r) => r.resourceId)).size === rows.length, {
        message: "Each resource may be required only once",
      }),
  })
  .strict();
export type ServiceResourceInput = z.infer<typeof serviceResourceInputSchema>;
export const serviceResourcesSchema = z.object({
  serviceId: idSchema,
  version: z.number().int().positive(),
  requirements: z.array(
    resourceRequirementSchema.extend({
      name: z.string(),
      capacity: z.number().int().positive(),
      active: z.boolean(),
    }),
  ),
});
export type ServiceResources = z.infer<typeof serviceResourcesSchema>;
