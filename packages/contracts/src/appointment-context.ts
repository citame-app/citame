import { z } from "zod";
import { idSchema, LIMITS } from "./common";

export const appointmentContextInputSchema = z
  .object({
    servicePosition: z.number().int().min(0).max(23),
    requestedStaffId: idSchema.nullable(),
    internalNote: z.string().max(LIMITS.notes).nullable(),
    customerComment: z.string().max(LIMITS.notes).nullable(),
    invoiced: z.boolean().nullable(),
    paid: z.boolean().nullable(),
  })
  .strict();
export const appointmentContextRowSchema = appointmentContextInputSchema.extend({
  version: z.number().int().positive(),
  source: z.enum(["citame", "booksy"]),
  sourceRef: z.string().nullable(),
});
export const appointmentContextSchema = z.object({
  appointmentVersion: z.number().int().positive().optional(),
  canEdit: z.boolean().optional(),
  defaultRequested: z.boolean().optional(),
  businessMessage: z.string().nullable().optional(),
  rows: z.array(appointmentContextRowSchema),
  customerComment: z.string().nullable().optional(),
});
export type AppointmentContextRow = z.infer<typeof appointmentContextRowSchema>;
export const appointmentContextUpdateSchema = z
  .object({
    appointmentVersion: z.number().int().positive(),
    servicePosition: z.number().int().min(0).max(23),
    version: z.number().int().nonnegative(),
    requested: z.boolean().optional(),
    internalNote: z.string().max(LIMITS.notes),
  })
  .strict();
export type AppointmentContextUpdate = z.infer<typeof appointmentContextUpdateSchema>;

/** Explicit target mapping; names and appointment times never implicitly match identities. */
export const booksyContextImportSchema = z
  .object({
    rows: z
      .array(
        appointmentContextInputSchema.extend({
          appointmentId: idSchema,
          appointmentVersion: z.number().int().positive(),
          contextVersion: z.number().int().nonnegative(),
          sourceRef: z.string().trim().min(1).max(160),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .refine(
    ({ rows }) =>
      new Set(rows.map((r) => `${r.appointmentId}:${r.servicePosition}`)).size === rows.length &&
      new Set(rows.map((r) => r.sourceRef)).size === rows.length,
    { message: "Duplicate appointment/service or source reference" },
  );
export type BooksyContextImport = z.infer<typeof booksyContextImportSchema>;
export const booksyContextReviewSchema = z.object({
  reviewHash: z.string(),
  appointments: z.number().int(),
  services: z.number().int(),
  internalNotes: z.number().int(),
  customerComments: z.number().int(),
  requested: z.number().int(),
  invoiced: z.number().int(),
  paid: z.number().int(),
  items: z.array(
    z.object({
      appointmentId: idSchema,
      servicePosition: z.number().int(),
      sourceRef: z.string(),
      serviceName: z.string(),
      startsAt: z.string(),
      action: z.enum(["add", "update", "unchanged"]),
    }),
  ),
});
export const booksyContextApplySchema = z.object({
  input: booksyContextImportSchema,
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const calendarServiceBadgesSchema = z.object({
  servicePosition: z.number().int().nonnegative(),
  requested: z.boolean(),
  invoiced: z.boolean(),
  paid: z.boolean(),
  billingSource: z.enum(["citame", "booksy"]).nullable(),
  internalNote: z.boolean(),
  customerComment: z.boolean(),
});
export type CalendarServiceBadges = z.infer<typeof calendarServiceBadgesSchema>;
