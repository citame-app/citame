import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clientProfile } from "./client";
import { createdAt, deletedAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { service } from "./service";
import { staffProfile } from "./staff";

export const appointmentStatus = pgEnum("appointment_status", [
  "booked",
  "completed",
  "cancelled",
  "no_show",
]);

/**
 * `ends_at` includes processing and cleanup. Frozen work windows feed internal staff reservations;
 * migration0037 protects active professional intervals, not the full client-presence span.
 */
export const appointment = pgTable(
  "appointment",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    /** Stable identity shared by the native lines of an imported visit. */
    visitGroupId: uuid(),
    /** Original capacity exception, populated only by the verified Booksy importer. */
    sourceStaffWindow: jsonb().$type<{ staffId: string; startsAt: string; endsAt: string }>(),
    /** Frozen equipment assignment eligible for a historical capacity exception. */
    sourceResourceWindow: jsonb().$type<{ resourceId: string; startsAt: string; endsAt: string }>(),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    status: appointmentStatus().notNull().default("booked"),
    notes: text(),
    requestedStaffId: uuid().references(() => staffProfile.id),
    customerComment: text(),
    sourceBusinessMessage: text(),
    workWindows: jsonb().$type<{ offsetMinutes: number; endOffsetMinutes: number }[]>(),
    /** Optimistic-concurrency counter, incremented on every update. */
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("appointment_ends_after_starts", sql`${t.endsAt} > ${t.startsAt}`),
    index("appointment_staff_starts_idx").on(t.staffId, t.startsAt),
    index("appointment_client_idx").on(t.clientId),
    index("appointment_visit_group_idx")
      .on(t.visitGroupId)
      .where(sql`${t.visitGroupId} is not null`),
  ],
);

/** Snapshot of each booked service so later catalog edits do not rewrite history. */
export const appointmentService = pgTable(
  "appointment_service",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    serviceId: uuid().references(() => service.id, { onDelete: "set null" }),
    position: integer().notNull(),
    name: text().notNull(),
    durationMinutes: integer().notNull(),
    bufferMinutes: integer().notNull(),
    processingStartMinutes: integer(),
    processingMinutes: integer(),
    priceCents: integer().notNull(),
    peakSurchargeCents: integer(),
    sourceUnpriced: boolean().notNull().default(false),
    reviewedPriceCents: integer(),
    priceType: text()
      .$type<"fixed" | "variable" | "hidden" | "free" | "from">()
      .notNull()
      .default("fixed"),
    currency: text().notNull(),
  },
  (t) => [
    check(
      "appointment_service_peak_price_valid",
      sql`${t.peakSurchargeCents} is null or ${t.peakSurchargeCents} between 1 and ${t.priceCents}`,
    ),
    index("appointment_service_appointment_idx").on(t.appointmentId),
    check(
      "appointment_service_reviewed_price_valid",
      sql`${t.reviewedPriceCents} is null or (${t.sourceUnpriced} and ${t.currency} = 'EUR' and ${t.reviewedPriceCents} between 0 and 999999999)`,
    ),
    check(
      "appointment_service_price_type_valid",
      sql`${t.priceType} in ('fixed','variable','hidden','free','from') and (${t.priceType} not in ('variable','free') or ${t.priceCents}=0)`,
    ),
    check(
      "appointment_service_processing_valid",
      sql`(${t.processingStartMinutes} is null and ${t.processingMinutes} is null) or (${t.processingStartMinutes} is not null and ${t.processingMinutes} is not null and ${t.processingStartMinutes}>0 and ${t.processingMinutes}>0 and ${t.processingStartMinutes}+${t.processingMinutes}<${t.durationMinutes})`,
    ),
  ],
);

/** Staff-only annotations. Never serialize into public appointments, sync or SSE payloads. */
export const appointmentContext = pgTable(
  "appointment_context",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    servicePosition: integer().notNull(),
    requestedStaffId: uuid().references(() => staffProfile.id),
    internalNote: text(),
    customerComment: text(),
    invoiced: boolean(),
    paid: boolean(),
    source: text().notNull().default("citame"),
    sourceRef: text(),
    sourcePaymentUnverified: boolean().notNull().default(false),
    billingVersion: integer().notNull().default(1),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("appointment_context_position_unique").on(t.appointmentId, t.servicePosition),
    unique("appointment_context_source_unique").on(t.source, t.sourceRef),
    check("appointment_context_position_valid", sql`${t.servicePosition} between 0 and 23`),
    check("appointment_context_source_valid", sql`${t.source} in ('citame','booksy')`),
  ],
);
