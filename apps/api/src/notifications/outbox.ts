import { type appointment, clientProfile, reminder } from "@sob/db";
import { and, eq } from "drizzle-orm";
import { getSalonSettings } from "../modules/settings/service";
import type { Tx } from "../tx";
import { planReminders } from "./schedule";

type AppointmentRow = typeof appointment.$inferSelect;
type Channel = "email" | "sms";
type Kind = (typeof reminder.$inferInsert)["kind"];

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
    .where(eq(clientProfile.id, clientId));
  const channels: Channel[] = [];
  if (client?.email) channels.push("email");
  if (client?.phone) channels.push("sms");
  return channels;
}

async function insertRows(
  tx: Tx,
  appt: AppointmentRow,
  items: { kind: Kind; scheduledFor: Date }[],
) {
  const channels = await channelsFor(tx, appt.clientId);
  const values = items.flatMap((item) =>
    channels.map((channel) => ({
      appointmentId: appt.id,
      kind: item.kind,
      channel,
      appointmentVersion: appt.version,
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

/** Withdraws everything that has not started sending yet. Rows in flight finish on their own. */
async function withdrawPending(tx: Tx, appointmentId: string) {
  await tx
    .update(reminder)
    .set({ status: "cancelled", lastError: "withdrawn: appointment changed" })
    .where(and(eq(reminder.appointmentId, appointmentId), eq(reminder.status, "pending")));
}

export async function scheduleNewAppointment(tx: Tx, appt: AppointmentRow, now: Date) {
  await insertRows(tx, appt, [
    { kind: "confirmation", scheduledFor: now },
    ...(await reminderPlan(tx, appt, now)),
  ]);
}

/** The slot or the staff member changed: old schedule out, new schedule and a notice in. */
export async function rescheduleAppointment(tx: Tx, appt: AppointmentRow, now: Date) {
  await withdrawPending(tx, appt.id);
  await insertRows(tx, appt, [
    { kind: "rescheduled", scheduledFor: now },
    ...(await reminderPlan(tx, appt, now)),
  ]);
}

/** Cancelled: tell the client. Completed or no-show: just stop the pending reminders. */
export async function closeAppointment(
  tx: Tx,
  appt: AppointmentRow,
  now: Date,
  options: { notify: boolean },
) {
  await withdrawPending(tx, appt.id);
  if (options.notify) await insertRows(tx, appt, [{ kind: "cancellation", scheduledFor: now }]);
}
