import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, updatedAt } from "./helpers";

export const intakeForm = pgTable(
  "intake_form",
  {
    id: primaryId(),
    draft: jsonb().$type<Record<string, unknown>>().notNull(),
    currentRevisionId: uuid().references((): AnyPgColumn => intakeRevision.id),
    active: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("intake_form_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "intake_form_valid",
      sql`${t.version}>0 and (not ${t.active} or ${t.currentRevisionId} is not null) and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const intakeRevision = pgTable(
  "intake_revision",
  {
    id: primaryId(),
    formId: uuid()
      .notNull()
      .references((): AnyPgColumn => intakeForm.id),
    number: integer().notNull(),
    title: text().notNull(),
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    contentHash: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("intake_revision_number_unique").on(t.formId, t.number),
    unique("intake_revision_content_unique").on(t.formId, t.contentHash),
    check(
      "intake_revision_valid",
      sql`${t.number}>0 and length(${t.title}) between 1 and 120 and ${t.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const intakeSubmission = pgTable(
  "intake_submission",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    revisionId: uuid()
      .notNull()
      .references(() => intakeRevision.id),
    appointmentId: uuid().references(() => appointment.id),
    answers: jsonb().$type<Record<string, unknown>>().notNull(),
    source: text().$type<"client" | "team">().notNull(),
    confirmationVersion: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("intake_submission_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("intake_submission_client_idx").on(t.clientId, t.createdAt),
    index("intake_submission_appointment_idx").on(t.appointmentId),
    check(
      "intake_submission_valid",
      sql`${t.source} in ('client','team') and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and length(${t.confirmationVersion}) between 1 and 80`,
    ),
  ],
);

/** One immutable response can accompany several reviewed visits (for example a series). */
export const intakeAppointment = pgTable(
  "intake_appointment",
  {
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id),
    submissionId: uuid()
      .notNull()
      .references(() => intakeSubmission.id),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.appointmentId, t.submissionId] }),
    index("intake_appointment_submission_idx").on(t.submissionId),
  ],
);
