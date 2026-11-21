import { z } from "zod";
import { appointmentSchema, createAppointmentBaseSchema } from "./appointments";
import { idSchema, instantSchema, LIMITS, localDateSchema, syncGenerationSchema } from "./common";

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
const desktopVisitPartSchema = visitPartSchema
  .extend({
    id: idSchema,
    serviceQuotes: createAppointmentBaseSchema.shape.serviceQuotes.unwrap(),
    intakeReviewHash: createAppointmentBaseSchema.shape.intakeReviewHash.unwrap(),
  })
  .strict();
export const desktopVisitInputSchema = visitCreateSchema
  .safeExtend({
    clientId: idSchema,
    desktopGeneration: syncGenerationSchema,
    parts: z.array(desktopVisitPartSchema).min(2).max(8),
  })
  .refine((visit) => new Set(visit.parts.map((part) => part.id)).size === visit.parts.length, {
    path: ["parts"],
    message: "Choose a different appointment ID for each step",
  });
export const desktopVisitCreateSchema = desktopVisitInputSchema.safeExtend({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DesktopVisitInput = z.infer<typeof desktopVisitInputSchema>;
export type DesktopVisitCreate = z.infer<typeof desktopVisitCreateSchema>;
export const desktopVisitPreviewSchema = z.object({
  reviewHash: z.string(),
  timezone: z.string(),
  currency: z.string(),
  depositEnabled: z.boolean(),
  parts: z
    .array(
      z.object({
        id: idSchema,
        startsAt: instantSchema,
        endsAt: instantSchema,
        priceCents: z.number().int().nonnegative(),
        priceStatus: z.enum(["fixed", "from", "pending"]),
        depositWaiverRequired: z.boolean(),
        available: z.boolean(),
      }),
    )
    .min(2)
    .max(8),
});
export type DesktopVisitPreview = z.infer<typeof desktopVisitPreviewSchema>;
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
