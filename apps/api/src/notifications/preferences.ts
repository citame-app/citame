import { type Database, notificationPreference } from "@sob/db";
import { and, eq } from "drizzle-orm";

export type Channel = "email" | "sms";
export type Category = "transactional" | "reminder";

/**
 * Defaults when the client never chose: email is on for everything, SMS is off until the
 * client opts in (consent is required before texting). Messages about a booking the client
 * made (confirmation, cancellation, reschedule) are transactional; time-based reminders are
 * the category that carries the unsubscribe link.
 */
export const DEFAULT_PREFERENCES: Record<Channel, Record<Category, boolean>> = {
  email: { transactional: true, reminder: true },
  sms: { transactional: false, reminder: false },
};

export const categoryOf = (kind: string): Category =>
  kind === "reminder_24h" || kind === "reminder_2h" ? "reminder" : "transactional";

export async function isEnabled(
  db: Pick<Database, "select">,
  clientId: string,
  channel: Channel,
  category: Category,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: notificationPreference.enabled })
    .from(notificationPreference)
    .where(
      and(
        eq(notificationPreference.clientId, clientId),
        eq(notificationPreference.channel, channel),
        eq(notificationPreference.category, category),
      ),
    );
  return row?.enabled ?? DEFAULT_PREFERENCES[channel][category];
}
