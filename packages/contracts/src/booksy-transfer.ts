import { z } from "zod";
import { timeOfDaySchema } from "./staff";

const ref = z.string().trim().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
const raw = z.record(z.string(), z.unknown());
const named = z.object({ sourceId: ref, name: z.string().min(1), raw });
const amount = z.number().int().nonnegative();
export const booksyStaffSchema = named.extend({
  active: z.boolean(),
  maxConcurrent: z.number().int().min(1).max(6).nullable(),
});
export const booksyServiceSchema = named
  .extend({
    description: z.string().nullable(),
    category: z.string().nullable(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .nullable(),
    durationMinutes: z.number().int().nonnegative(),
    catalogKind: z.enum(["service", "addon"]).optional(),
    addonParentRefs: z.array(ref).min(1).max(100).optional(),
    bufferMinutes: z.number().int().nonnegative(),
    priceCents: amount,
    currency: z.literal("EUR"),
    active: z.boolean(),
  })
  .refine((s) => s.catalogKind === "addon" || s.durationMinutes > 0, {
    message: "A primary service requires a positive duration",
  });
export const booksyClientSchema = named.extend({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  contactDetails: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).max(20).optional(),
  bookingAccess: z.enum(["normal", "blocked", "trusted"]).optional(),
});
export const booksyVisitSchema = z.object({
  sourceId: ref,
  clientRef: ref,
  staffRef: ref,
  startsAt: instant,
  endsAt: instant,
  status: z.enum(["booked", "completed", "cancelled", "no_show"]),
  customerComment: z.string().nullable(),
  internalNote: z.string().nullable(),
  services: z
    .array(
      z.object({
        sourceId: ref,
        serviceRef: ref,
        name: z.string().min(1),
        durationMinutes: z.number().int().positive(),
        bufferMinutes: z.number().int().nonnegative(),
        priceCents: amount,
        currency: z.literal("EUR"),
        requestedStaffRef: ref.nullable(),
        invoiced: z.boolean().nullable(),
        paid: z.boolean().nullable(),
        customerComment: z.string().nullable(),
        internalNote: z.string().nullable(),
        raw,
      }),
    )
    .min(1)
    .max(24),
  raw,
});
export const booksyCoverageSchema = z.object({
  state: z.enum(["complete", "partial", "not_captured"]),
  expected: z.number().int().nonnegative().nullable(),
  evidence: z.array(z.string()).min(1),
});
export const booksyTransferSchema = z
  .object({
    version: z.literal(1),
    businessId: ref,
    capturedAt: instant,
    timezone: z.literal("Europe/Madrid"),
    fromDate: z.iso.date(),
    horizon: z.object({
      lastAppointmentAt: instant.nullable(),
      lastAppointmentProven: z.boolean(),
      evidence: z.array(z.string()).min(1),
    }),
    coverage: z.record(
      z.enum([
        "appointments",
        "services",
        "staff",
        "clients",
        "hours",
        "timeOff",
        "resources",
        "inventory",
        "waitlist",
        "passes",
        "giftCards",
        "consents",
        "attachments",
        "finance",
      ]),
      booksyCoverageSchema,
    ),
    artifacts: z.array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
      }),
    ),
    staff: z.array(booksyStaffSchema),
    services: z.array(booksyServiceSchema),
    clients: z.array(booksyClientSchema),
    appointments: z.array(booksyVisitSchema),
    assignments: z.array(z.object({ staffRef: ref, serviceRef: ref })),
    hours: z.array(
      z.object({
        sourceId: ref,
        staffRef: ref,
        weekday: z.number().int().min(0).max(6),
        start: timeOfDaySchema,
        end: timeOfDaySchema,
        raw,
      }),
    ),
    timeOff: z.array(
      z.object({
        sourceId: ref,
        staffRef: ref,
        startsAt: instant,
        endsAt: instant,
        reason: z.string().nullable(),
        raw,
      }),
    ),
    /** Unmapped entities remain preserved and block promotion; no silent truncation or defaults. */
    unprojected: z.array(z.object({ kind: ref, sourceId: ref, raw })),
  })
  .strict();
export type BooksyTransfer = z.infer<typeof booksyTransferSchema>;
