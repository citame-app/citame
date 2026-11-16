import { z } from "zod";
import { idSchema, instantSchema } from "./common";
export const processingTimeSchema = z
  .object({
    startsAfterMinutes: z.number().int().min(1).max(1438),
    minutes: z.number().int().min(1).max(1438),
  })
  .strict();
export const serviceProcessingInputSchema = z
  .object({ version: z.number().int().positive(), processing: processingTimeSchema.nullable() })
  .strict();
export const staffCapacityInputSchema = z
  .object({
    version: z.number().int().positive(),
    maxConcurrent: z.number().int().min(1).max(6),
    confirmed: z.literal(true),
  })
  .strict();
export const staffCapacitySchema = z.object({
  staffId: idSchema,
  version: z.number().int().positive(),
  maxConcurrent: z.number().int().min(1).max(6),
  effectiveAt: instantSchema,
});
export const workWindowSchema = z
  .object({
    offsetMinutes: z.number().int().nonnegative(),
    endOffsetMinutes: z.number().int().positive(),
  })
  .strict()
  .refine((w) => w.endOffsetMinutes > w.offsetMinutes);
export type ProcessingTime = z.infer<typeof processingTimeSchema>;
export type ServiceProcessingInput = z.infer<typeof serviceProcessingInputSchema>;
export type StaffCapacityInput = z.infer<typeof staffCapacityInputSchema>;
export type StaffCapacity = z.infer<typeof staffCapacitySchema>;
export type WorkWindow = z.infer<typeof workWindowSchema>;
