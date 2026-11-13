import { z } from "zod";
import { idSchema, instantSchema, localDateSchema } from "./common";

export const availabilityQuerySchema = z.object({
  serviceIds: z
    .string()
    .transform((value) => value.split(",").filter((part) => part.length > 0))
    .pipe(z.array(idSchema).min(1)),
  staffId: idSchema.optional(),
  date: localDateSchema,
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const slotSchema = z.object({
  staffId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
});

export type Slot = z.infer<typeof slotSchema>;

export const availabilityResponseSchema = z.object({
  date: localDateSchema,
  timezone: z.string(),
  slots: z.array(slotSchema),
});

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
