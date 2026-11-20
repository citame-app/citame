import { z } from "zod";
import { appointmentSchema, createAppointmentBaseSchema } from "./appointments";
import { idSchema, instantSchema, LIMITS, localDateSchema } from "./common";

const visitPartSchema = createAppointmentBaseSchema.omit({
  id: true,
  startsAt: true,
  client: true,
  clientId: true,
  notes: true,
  override: true,
});
export const visitCreateSchema = z
  .object({
    id: idSchema,
    startsAt: instantSchema,
    clientId: idSchema.optional(),
    notes: z.string().max(LIMITS.notes).optional(),
    parts: z.array(visitPartSchema).min(2).max(8),
  })
  .strict()
  .refine(
    (v) => {
      const ids = v.parts.flatMap((p) => p.serviceIds);
      return ids.length <= 24 && new Set(ids).size === ids.length;
    },
    { message: "Choose up to 24 distinct services in the visit" },
  );
export type VisitCreate = z.infer<typeof visitCreateSchema>;
export const visitSchema = z.object({
  id: idSchema,
  appointments: z.array(appointmentSchema).min(2).max(8),
});
export type Visit = z.infer<typeof visitSchema>;
export const visitAvailabilitySchema = z
  .object({
    date: localDateSchema,
    parts: z
      .array(
        z
          .object({ serviceIds: z.array(idSchema).min(1).max(24), staffId: idSchema.optional() })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict()
  .refine(
    (v) => {
      const ids = v.parts.flatMap((p) => p.serviceIds);
      return ids.length <= 24 && new Set(ids).size === ids.length;
    },
    { message: "Choose distinct services" },
  );
export type VisitAvailability = z.infer<typeof visitAvailabilitySchema>;
export const visitSlotsSchema = z.object({
  slots: z.array(
    z.object({
      startsAt: instantSchema,
      endsAt: instantSchema,
      parts: z
        .array(
          z.object({
            staffId: idSchema,
            startsAt: instantSchema,
            serviceIds: z.array(idSchema).min(1).max(24),
          }),
        )
        .min(2)
        .max(8),
    }),
  ),
});
export type VisitSlots = z.infer<typeof visitSlotsSchema>;
