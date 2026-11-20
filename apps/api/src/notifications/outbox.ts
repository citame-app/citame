import { appointment, bookingProtection, clientProfile, reminder } from "@sob/db";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getSalonSettings } from "../modules/settings/service";
import type { Tx } from "../tx";
import { planReminders } from "./schedule";

type AppointmentRow = typeof appointment.$inferSelect;

import { activeRules, readConnection } from "./whatsapp/service";

type Channel = (typeof reminder.$inferInsert)["channel"];
type Kind = (typeof reminder.$inferInsert)["kind"];
const timedReminder = (kind: Kind) => kind === "reminder_24h" || kind === "reminder_2h";

/**
 * The transactional half of the notification system (ADR 0010). Everything here runs on the
 * caller's transaction, so reminders appear and disappear atomically with the appointment
 * change that caused them: a rolled-back booking leaves no reminder behind, and a committed
 * cancellation can never lose its notice. Sending happens later, in the worker.
 */

/** Channels worth scheduling: the client has an address for them. Consent is checked on send. */
async function channelsFor(tx: Tx, clientId: string): Promise<Channel[]> {
  const [client] = await tx
    .select({ email: clientProfile.email, phone: clientProfile.phone })
    .from(clientProfile)
    .where(eq(clientProfile.id, sql`client_root_id(${clientId}::uuid)`));
  const channels: Channel[] = [];
  if (client?.email) channels.push("email");
  if (client?.phone) channels.push("sms");
  return channels;
}

async function insertRows(
  tx: Tx,
  appt: AppointmentRow,
  items: { kind: Kind; scheduledFor: Date }[],
  now: Date,
) {
  const channels = await channelsFor(tx, appt.clientId);
  const rules = channels.includes("sms") ? activeRules(await readConnection(tx), now) : [];
  const values = items.flatMap((item) =>
    [
      ...channels,
      ...rules.filter((rule) => rule.kind === item.kind).map(() => "whatsapp" as const),
    ].map((channel) => ({
      appointmentId: appt.id,
      kind: item.kind,
      channel,
      appointmentVersion: appt.version,
      whatsappStartsAt: channel === "whatsapp" && timedReminder(item.kind) ? appt.startsAt : null,
      scheduledFor: item.scheduledFor,
    })),
  );
  if (values.length === 0) return;
  // The unique key makes a repeated call (a replayed mutation) a no-op instead of a duplicate.
  await tx.insert(reminder).values(values).onConflictDoNothing();
}

async function reminderPlan(tx: Tx, appt: AppointmentRow, now: Date) {
  const settings = await getSalonSettings(tx);
  return planReminders({
    startsAt: appt.startsAt,
    now,
    timeZone: settings.timezone,
    firstLeadMinutes: settings.reminderFirstLeadMinutes,
    secondLeadMinutes: settings.reminderSecondLeadMinutes,
  });
}

/**
 * Withdraws everything that has not been sent. That includes rows a worker is sending right
 * now: the send in flight cannot be recalled, but the worker's own bookkeeping is fenced on
 * `processing`, so once withdrawn it can neither record the outcome nor put the row back to
 * `pending` for a retry after a failure (which would send a reminder for a superseded schedule).
 */
async function withdrawPending(tx: Tx, appointmentId: string) {
  await tx
    .update(reminder)
    .set({ status: "cancelled", lockedUntil: null, lastError: "withdrawn: appointment changed" })
    .where(
      and(
        eq(reminder.appointmentId, appointmentId),
        inArray(reminder.status, ["pending", "processing"]),
      ),
    );
}

export async function scheduleNewAppointment(tx: Tx, appt: AppointmentRow, now: Date) {
  await insertRows(
    tx,
    appt,
    [{ kind: "confirmation", scheduledFor: now }, ...(await reminderPlan(tx, appt, now))],
    now,
  );
}

/** The slot or the staff member changed: old schedule out, new schedule and a notice in. */
export async function rescheduleAppointment(tx: Tx, appt: AppointmentRow, now: Date) {
  await withdrawPending(tx, appt.id);
  await insertRows(
    tx,
    appt,
    [{ kind: "rescheduled", scheduledFor: now }, ...(await reminderPlan(tx, appt, now))],
    now,
  );
}

/** Cancelled: tell the client. Completed or no-show: just stop the pending reminders. */
export async function closeAppointment(
  tx: Tx,
  appt: AppointmentRow,
  now: Date,
  options: { notify: boolean },
) {
  await withdrawPending(tx, appt.id);
  if (options.notify)
    await insertRows(tx, appt, [{ kind: "cancellation", scheduledFor: now }], now);
}

/** The caller holds the scheduling lock while changing rules and applying them to future visits. */
export async function backfillWhatsAppReminders(tx: Tx, now: Date, enabled: ReadonlySet<Kind>) {
  if (!enabled.has("reminder_24h") && !enabled.has("reminder_2h")) return;
  const settings = await getSalonSettings(tx);
  const bookings = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt, version: appointment.version })
    .from(appointment)
    .innerJoin(
      clientProfile,
      eq(clientProfile.id, sql`client_root_id(${appointment.clientId}::uuid)`),
    )
    .where(
      and(
        sql`not exists (select 1 from ${bookingProtection} where ${bookingProtection.appointmentId} = ${appointment.id} and ${bookingProtection.state} = 'pending')`,
        eq(appointment.status, "booked"),
        gt(appointment.startsAt, now),
        isNull(appointment.deletedAt),
        isNull(clientProfile.deletedAt),
        sql`${clientProfile.phone} is not null`,
      ),
    );
  const values = bookings.flatMap((booking) =>
    planReminders({
      startsAt: booking.startsAt,
      now,
      timeZone: settings.timezone,
      firstLeadMinutes: settings.reminderFirstLeadMinutes,
      secondLeadMinutes: settings.reminderSecondLeadMinutes,
    })
      .filter(({ kind }) => enabled.has(kind))
      .map((plan) => ({
        ...plan,
        appointmentId: booking.id,
        appointmentVersion: booking.version,
        channel: "whatsapp" as const,
        whatsappStartsAt: booking.startsAt,
      })),
  );
  for (let offset = 0; offset < values.length; offset += 500) {
    const batch = values.slice(offset, offset + 500);
    const active = await tx
      .select({
        appointmentId: reminder.appointmentId,
        kind: reminder.kind,
        startsAt: reminder.whatsappStartsAt,
        scheduledFor: reminder.scheduledFor,
        status: reminder.status,
      })
      .from(reminder)
      .where(
        and(
          eq(reminder.channel, "whatsapp"),
          inArray(reminder.appointmentId, [
            ...new Set(batch.map(({ appointmentId }) => appointmentId)),
          ]),
          or(
            inArray(reminder.status, ["pending", "processing", "sent"]),
            isNotNull(reminder.whatsappDispatchAt),
          ),
        ),
      );
    const byVisit = new Map<string, typeof active>();
    for (const row of active) {
      const rows = byVisit.get(row.appointmentId) ?? [];
      rows.push(row);
      byVisit.set(row.appointmentId, rows);
    }
    const missing = batch.filter(
      (plan) =>
        !byVisit
          .get(plan.appointmentId)
          ?.some(
            (row) =>
              row.kind === plan.kind &&
              (row.startsAt
                ? row.startsAt.getTime() === plan.whatsappStartsAt.getTime()
                : row.status === "pending" ||
                  row.status === "processing" ||
                  row.scheduledFor.getTime() === plan.scheduledFor.getTime()),
          ),
    );
    if (!missing.length) continue;
    await tx
      .insert(reminder)
      .values(missing)
      .onConflictDoUpdate({
        target: [
          reminder.appointmentId,
          reminder.kind,
          reminder.channel,
          reminder.appointmentVersion,
        ],
        set: {
          scheduledFor: sql`excluded.scheduled_for`,
          whatsappStartsAt: sql`excluded.whatsapp_starts_at`,
          status: "pending",
          lastError: null,
        },
        setWhere: and(
          eq(reminder.status, "cancelled"),
          inArray(reminder.lastError, ["whatsapp_disconnected", "whatsapp_rule_disabled"]),
          isNull(reminder.whatsappDispatchAt),
        ),
      });
  }
}
