import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { bunJsonb, createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

/** Commercial permission is independent of transactional reminders; missing rows deny marketing. */
export const marketingConsent = pgTable(
  "marketing_consent",
  {
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id, { onDelete: "cascade" }),
    channel: text().$type<"email" | "sms">().notNull(),
    enabled: boolean().notNull(),
    source: text().notNull(),
    version: integer().notNull().default(1),
    recordedBy: text().references(() => user.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.channel] }),
    check("marketing_consent_valid", sql`${t.channel} in ('email','sms') and ${t.version}>0`),
  ],
);

export const marketingCampaign = pgTable(
  "marketing_campaign",
  {
    id: primaryId(),
    name: text().notNull(),
    purpose: text()
      .$type<"campaign" | "review_request" | "booking_invitation">()
      .notNull()
      .default("campaign"),
    channel: text().$type<"email" | "sms" | "optimized">().notNull(),
    subject: text().notNull().default(""),
    emailBody: text().notNull().default(""),
    smsBody: text().notNull().default(""),
    audience: bunJsonb<{
      tags: string[];
      inactiveDays: number | null;
      noFutureAppointments: boolean;
      selectedClientIds?: string[];
    }>()
      .notNull()
      .default(sql`'{"tags":[],"inactiveDays":null,"noFutureAppointments":false}'::jsonb`),
    trigger: text()
      .$type<"manual" | "first_visit" | "inactive" | "birthday">()
      .notNull()
      .default("manual"),
    delayMinutes: integer().notNull().default(120),
    birthdayLeadDays: integer().notNull().default(7),
    status: text()
      .$type<"draft" | "scheduled" | "active" | "completed" | "cancelled">()
      .notNull()
      .default("draft"),
    version: integer().notNull().default(1),
    scheduledFor: timestamptz(),
    activatedAt: timestamptz(),
    evaluatedAt: timestamptz(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    requestDigest: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("marketing_campaign_schedule_idx").on(t.status, t.scheduledFor),
    check(
      "marketing_campaign_purpose_valid",
      sql`case when ${t.purpose} = 'booking_invitation'
        then ${t.trigger} = 'manual' and case
          when jsonb_typeof(${t.audience}->'selectedClientIds') = 'array'
          then jsonb_array_length(${t.audience}->'selectedClientIds') between 1 and 100
          else false end
        else ${t.purpose} in ('campaign','review_request') and not (${t.audience} ? 'selectedClientIds')
        end`,
    ),
    check(
      "marketing_campaign_valid",
      sql`${t.channel} in ('email','sms','optimized') and ${t.trigger} in ('manual','first_visit','inactive','birthday') and ${t.status} in ('draft','scheduled','active','completed','cancelled') and ${t.version}>0 and ${t.delayMinutes} between 0 and 525600 and ${t.birthdayLeadDays} between 0 and 30`,
    ),
  ],
);

/** Addresses are looked up immediately before delivery and never copied into this queue. */
export const marketingDelivery = pgTable(
  "marketing_delivery",
  {
    id: primaryId(),
    campaignId: uuid()
      .notNull()
      .references(() => marketingCampaign.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    channel: text().$type<"email" | "sms">().notNull(),
    occurrence: text().notNull(),
    reviewAppointmentId: uuid().references(() => appointment.id, { onDelete: "cascade" }),
    status: text()
      .$type<"pending" | "processing" | "sent" | "skipped" | "failed" | "unknown" | "cancelled">()
      .notNull()
      .default("pending"),
    scheduledFor: timestamptz().notNull(),
    lockedBy: text(),
    lockedUntil: timestamptz(),
    reason: text(),
    providerMessageId: text(),
    sentAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("marketing_delivery_occurrence_unique").on(t.campaignId, t.clientId, t.occurrence),
    unique("marketing_delivery_review_appointment_unique").on(t.reviewAppointmentId),
    index("marketing_delivery_due_idx").on(t.status, t.scheduledFor),
    index("marketing_delivery_campaign_idx").on(t.campaignId, t.createdAt, t.id),
    check(
      "marketing_delivery_valid",
      sql`${t.channel} in ('email','sms') and ${t.status} in ('pending','processing','sent','skipped','failed','unknown','cancelled')`,
    ),
  ],
);
