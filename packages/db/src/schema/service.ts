import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, primaryId, updatedAt } from "./helpers";

export const service = pgTable(
  "service",
  {
    id: primaryId(),
    name: text().notNull(),
    description: text(),
    category: text(),
    sortOrder: integer().notNull().default(0),
    onlineBooking: boolean().notNull().default(true),
    clientInstructions: text(),
    bookingIntervalMinutes: integer(),
    durationMinutes: integer().notNull(),
    /** Cleanup/transition time blocked after the service. */
    bufferMinutes: integer().notNull().default(0),
    processingStartMinutes: integer(),
    processingMinutes: integer(),
    priceCents: integer().notNull(),
    priceType: text()
      .$type<"fixed" | "variable" | "hidden" | "free" | "from">()
      .notNull()
      .default("fixed"),
    currency: text().notNull().default("ARS"),
    resourceVersion: integer().notNull().default(1),
    catalogKind: text().$type<"service" | "variant" | "addon">().notNull().default("service"),
    parentServiceId: uuid().references((): AnyPgColumn => service.id),
    optionLabel: text(),
    catalogVersion: integer().notNull().default(1),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check(
      "service_duration_positive",
      sql`${t.durationMinutes} > 0 or (${t.catalogKind}='addon' and ${t.durationMinutes}>=0)`,
    ),
    check(
      "service_catalog_valid",
      sql`${t.catalogVersion}>0 and ((${t.catalogKind}='service' and ${t.parentServiceId} is null and ${t.optionLabel} is null) or (${t.catalogKind}='variant' and ${t.parentServiceId} is not null and ${t.optionLabel} is not null and length(trim(${t.optionLabel})) between 1 and 80) or (${t.catalogKind}='addon' and ${t.parentServiceId} is null and ${t.optionLabel} is null))`,
    ),
    index("service_parent_idx").on(t.parentServiceId),
    check(
      "service_processing_valid",
      sql`(${t.processingStartMinutes} is null and ${t.processingMinutes} is null) or (${t.processingStartMinutes} is not null and ${t.processingMinutes} is not null and ${t.processingStartMinutes}>0 and ${t.processingMinutes}>0 and ${t.processingStartMinutes}+${t.processingMinutes}<${t.durationMinutes})`,
    ),
    check("service_buffer_non_negative", sql`${t.bufferMinutes} >= 0`),
    check("service_price_non_negative", sql`${t.priceCents} >= 0`),
    check(
      "service_price_type_valid",
      sql`${t.priceType} in ('fixed','variable','hidden','free','from') and (${t.priceType} not in ('variable','free') or ${t.priceCents}=0)`,
    ),
    check(
      "service_category_valid",
      sql`${t.category} is null or (length(trim(${t.category})) between 1 and 80 and ${t.category}=trim(${t.category}))`,
    ),
    check("service_sort_order_valid", sql`${t.sortOrder} between 0 and 100000`),
    check(
      "service_booking_interval_valid",
      sql`${t.bookingIntervalMinutes} is null or ${t.bookingIntervalMinutes} between 1 and 120`,
    ),
    check(
      "service_instructions_valid",
      sql`${t.clientInstructions} is null or length(${t.clientInstructions})<=2000`,
    ),
  ],
);

/** Explicit eligible services for an add-on; root eligibility includes its variants. */
export const serviceAddon = pgTable(
  "service_addon",
  {
    addonId: uuid()
      .notNull()
      .references(() => service.id),
    serviceId: uuid()
      .notNull()
      .references(() => service.id),
  },
  (t) => [
    primaryKey({ columns: [t.addonId, t.serviceId] }),
    check("service_addon_not_self", sql`${t.addonId}<>${t.serviceId}`),
    index("service_addon_target_idx").on(t.serviceId),
  ],
);
