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
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

export const review = pgTable(
  "review",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    publicName: text(),
    rating: integer(),
    body: text(),
    shareServices: boolean().notNull().default(false),
    allowSocialUse: boolean().notNull().default(false),
    socialPermissionVersion: text(),
    services: jsonb().$type<{ id: string | null; name: string }[]>().notNull(),
    status: text().notNull().default("pending"),
    moderationReason: text(),
    reply: text(),
    publicationVersion: text().notNull(),
    version: integer().notNull().default(1),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("review_appointment_unique").on(t.appointmentId),
    unique("review_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("review_status_id_idx").on(t.status, t.id),
    index("review_client_id_idx").on(t.clientId, t.id),
    check(
      "review_valid",
      sql`${t.version}>0 and (${t.allowSocialUse}=false or (${t.socialPermissionVersion} is not null and ${t.socialPermissionVersion}='public-review-social-v1')) and ${t.status} in ('pending','published','hidden','withdrawn') and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ((${t.status}='withdrawn' and ${t.publicName} is null and ${t.body} is null and ${t.rating} is null and ${t.reply} is null and ${t.moderationReason} is null and ${t.shareServices}=false and ${t.allowSocialUse}=false) or (${t.status}<>'withdrawn' and ${t.publicName} is not null and length(btrim(${t.publicName})) between 1 and 80 and ${t.body} is not null and length(btrim(${t.body})) between 1 and 2000 and ${t.rating} is not null and ${t.rating} between 1 and 5)) and (${t.reply} is null or length(btrim(${t.reply})) between 1 and 1000) and (${t.status}<>'published' or ${t.publishedAt} is not null) and (${t.status}<>'hidden' or (${t.moderationReason} is not null and length(btrim(${t.moderationReason})) between 1 and 300))`,
    ),
  ],
);
