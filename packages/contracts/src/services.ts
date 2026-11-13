import { z } from "zod";
import { idSchema } from "./common";

export const serviceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  durationMinutes: z.number().int().positive(),
  bufferMinutes: z.number().int().min(0),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
});

export type Service = z.infer<typeof serviceSchema>;

export const listServicesResponseSchema = z.object({ services: z.array(serviceSchema) });
export type ListServicesResponse = z.infer<typeof listServicesResponseSchema>;
