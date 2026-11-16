import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
export const benefitPlan = pgTable(
  "benefit_plan",
  {
    id: primaryId(),
    name: text().notNull(),
    description: text(),
    kind: text().notNull(),
    priceCents: integer().notNull(),
    taxBasisPoints: integer().notNull().default(0),
    includedUses: integer().notNull(),
    discountBasisPoints: integer().notNull().default(0),
    serviceIds: uuid().array().notNull(),
    validityDays: integer(),
    periodMonths: integer(),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("benefit_plan_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "benefit_plan_valid",
      sql`${t.priceCents} between 1 and 999999999 and ${t.includedUses} between 0 and 1000 and ${t.priceCents} >= ${t.includedUses} and ${t.taxBasisPoints} between 0 and 10000 and ${t.discountBasisPoints} between 0 and 10000 and cardinality(${t.serviceIds}) between 1 and 100 and ${t.version}>0 and ((${t.kind}='package' and ${t.includedUses}>0 and ${t.periodMonths} is null and ${t.discountBasisPoints}=0 and (${t.validityDays} is null or ${t.validityDays} between 1 and 3650)) or (${t.kind}='membership' and ${t.periodMonths} between 1 and 12 and ${t.validityDays} is null and (${t.includedUses}>0 or ${t.discountBasisPoints}>0)))`,
    ),
  ],
);
export const passContract = pgTable(
  "pass_contract",
  {
    id: primaryId(),
    planId: uuid()
      .notNull()
      .references(() => benefitPlan.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    kind: text().notNull(),
    name: text().notNull(),
    priceCents: integer().notNull(),
    taxBasisPoints: integer().notNull(),
    includedUses: integer().notNull(),
    discountBasisPoints: integer().notNull(),
    serviceIds: uuid().array().notNull(),
    validityDays: integer(),
    periodMonths: integer(),
    timezone: text().notNull(),
    status: text().notNull().default("pending"),
    renewalMode: text().notNull().default("manual"),
    autoPayReady: boolean().notNull().default(false),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    anchorAt: timestamptz(),
    consent: jsonb().$type<{
      version: string;
      planVersion: number;
      acceptedAt: string;
      termsHash: string;
      actorUserId: string;
    }>(),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pass_contract_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("pass_contract_client_idx").on(t.clientId, t.createdAt),
    check(
      "pass_contract_valid",
      sql`${t.status} in ('pending','active','cancelled','void') and ${t.renewalMode} in ('manual','automatic') and ${t.priceCents} between 1 and 999999999 and ${t.includedUses} between 0 and 1000 and ${t.priceCents}>=${t.includedUses} and ${t.discountBasisPoints} between 0 and 10000 and ${t.taxBasisPoints} between 0 and 10000 and ${t.version}>0`,
    ),
  ],
);
export const passPeriod = pgTable(
  "pass_period",
  {
    id: primaryId(),
    contractId: uuid()
      .notNull()
      .references(() => passContract.id),
    index: integer().notNull(),
    status: text().notNull().default("pending"),
    priceCents: integer().notNull(),
    startsAt: timestamptz(),
    endsAt: timestamptz(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pass_period_contract_index_unique").on(t.contractId, t.index),
    index("pass_period_ends_idx").on(t.endsAt),
    check(
      "pass_period_valid",
      sql`${t.status} in ('pending','active','void') and ${t.index} between 0 and 10000 and ${t.priceCents} between 1 and 999999999 and ${t.version}>0 and (${t.endsAt} is null or ${t.endsAt}>${t.startsAt})`,
    ),
  ],
);
/** Bank references are encrypted; cancellation erases the local capability. */
export const passMandate = pgTable(
  "pass_mandate",
  {
    id: primaryId(),
    contractId: uuid()
      .notNull()
      .references(() => passContract.id)
      .unique(),
    merchantCode: text().notNull(),
    terminal: text().notNull(),
    environment: text().notNull(),
    currency: text().notNull().default("EUR"),
    encryptedPayload: text(),
    expiry: text().notNull(),
    last4: text(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "pass_mandate_valid",
      sql`${t.environment} in ('test','live') and ${t.currency}='EUR' and length(${t.expiry})=4 and (${t.last4} is null or length(${t.last4})=4) and (${t.revokedAt} is not null or ${t.encryptedPayload} is not null)`,
    ),
  ],
);
