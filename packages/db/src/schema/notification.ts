import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { auditLog } from "./audit";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

/** Per-user inbox state. Events remain in the audit trail; archiving never deletes them. */
export const calendarNoticeArchive = pgTable(
  "calendar_notice_archive",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    auditId: uuid()
      .notNull()
      .references(() => auditLog.id, { onDelete: "cascade" }),
    archivedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.auditId] })],
);

export const reminderKind = pgEnum("reminder_kind", [
  "confirmation",
  "reminder_24h",
  "reminder_2h",
  "cancellation",
  "rescheduled",
]);

export const notificationChannel = pgEnum("notification_channel", ["email", "sms", "whatsapp"]);

export const reminderStatus = pgEnum("reminder_status", [
  "pending",
  "processing",
  "sent",
  "failed",
  "skipped",
  "cancelled",
]);

export const notificationCategory = pgEnum("notification_category", ["transactional", "reminder"]);

/** Durable account-email jobs. Contact details and action links are encrypted, never synced. */
export const accountEmailOutbox = pgTable(
  "account_email_outbox",
  {
    id: primaryId(),
    idempotencyKey: text().notNull().unique(),
    throttleKey: text().notNull(),
    payload: text().notNull(),
    expiresAt: timestamptz().notNull(),
    scheduledFor: timestamptz().notNull(),
    status: reminderStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    lockedUntil: timestamptz(),
    lockedBy: text(),
    sentAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("account_email_due_idx")
      .on(t.scheduledFor)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index("account_email_throttle_idx").on(t.throttleKey, t.createdAt),
  ],
);

/**
 * Outbox of notifications, also the job queue (ADR 0010). Rows are written in the same
 * transaction as the appointment change that causes them; the worker claims due rows with
 * `FOR UPDATE SKIP LOCKED` and a visibility timeout (`locked_until`). This table is NOT in the
 * sync triggers: notifications are server-side state the desktop client never sees.
 *
 * The unique key is what guarantees at-most-once per message: one row per
 * (appointment, kind, channel, appointment version). Moving an appointment bumps its version,
 * so the old schedule is cancelled and a fresh row is issued without colliding.
 */
export const reminder = pgTable(
  "reminder",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    kind: reminderKind().notNull(),
    channel: notificationChannel().notNull(),
    /** `appointment.version` this row was scheduled for. */
    appointmentVersion: integer().notNull(),
    scheduledFor: timestamptz().notNull(),
    status: reminderStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    providerMessageId: text(),
    whatsappDispatchAt: timestamptz(),
    /** Sender recorded when the WhatsApp send starts, independent of the active connection. */
    whatsappDispatchWabaId: text(),
    whatsappDispatchPhoneId: text(),
    whatsappStartsAt: timestamptz(),
    whatsappDelivery: text(),
    /** Visibility timeout: a `processing` row whose lease expired is claimable again. */
    lockedUntil: timestamptz(),
    lockedBy: text(),
    sentAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("reminder_once_per_version").on(
      t.appointmentId,
      t.kind,
      t.channel,
      t.appointmentVersion,
    ),
    // Only timed WhatsApp reminders populate this field. Notes and edits unrelated to
    // scheduling can bump the appointment version without creating a new time slot.
    uniqueIndex("reminder_whatsapp_once_per_slot")
      .on(t.appointmentId, t.kind, t.whatsappStartsAt)
      .where(
        sql`${t.whatsappStartsAt} is not null and (${t.status} in ('pending', 'processing', 'sent') or ${t.whatsappDispatchAt} is not null)`,
      ),
    // The claim query scans only rows that can still run.
    index("reminder_due_idx")
      .on(t.scheduledFor)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index("reminder_appointment_idx").on(t.appointmentId),
  ],
);

/**
 * Explicit overrides of the defaults: email is on for both categories, SMS is off until the
 * client opts in (consent). A missing row means "default". Transactional messages
 * (confirmation, cancellation, rescheduled) are service messages; reminders carry the
 * unsubscribe link.
 */
export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id, { onDelete: "cascade" }),
    channel: notificationChannel().notNull(),
    category: notificationCategory().notNull(),
    enabled: boolean().notNull(),
    destinationHash: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_preference_unique").on(t.clientId, t.channel, t.category)],
);

/** One sender per Citame installation, matching the singleton salon settings. */
export const whatsappConnection = pgTable("whatsapp_connection", {
  id: integer().primaryKey().default(1),
  wabaId: text().notNull(),
  phoneId: text().notNull(),
  phone: text().notNull(),
  coexistence: boolean().notNull(),
  encryptedToken: text().notNull(),
  expiresAt: timestamptz(),
  rules: jsonb().notNull().default(sql`'[]'::jsonb`),
  updatedAt: updatedAt(),
});
