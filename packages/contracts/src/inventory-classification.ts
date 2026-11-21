import { z } from "zod";
import { idSchema, requiredTextSchema, syncGenerationSchema } from "./common";

const uuid = idSchema.transform((id) => id.toLowerCase());
const kind = z.enum(["category", "brand"]);
const position = z.number().int().min(0).max(2147483646);
const fields = {
  kind,
  parentId: uuid.nullable(),
  position,
  active: z.boolean(),
};

export const inventoryClassificationSchema = z.object({
  ...fields,
  id: uuid,
  version: position.positive(),
  name: z.string(),
});
export const inventoryClassificationListSchema = z.object({
  entries: z.array(inventoryClassificationSchema),
  generation: syncGenerationSchema,
});
export const inventoryClassificationInputSchema = z.strictObject({
  ...fields,
  name: requiredTextSchema(100),
  generation: syncGenerationSchema,
  version: position,
});
export const inventoryClassificationAssignmentSchema = z.strictObject({
  categoryId: uuid.nullable(),
  subcategoryId: uuid.nullable(),
  brandId: uuid.nullable(),
});
export type InventoryClassificationInput = z.infer<typeof inventoryClassificationInputSchema>;
export type InventoryClassificationAssignment = z.infer<
  typeof inventoryClassificationAssignmentSchema
>;

export type InventoryClassification = z.infer<typeof inventoryClassificationSchema>;
