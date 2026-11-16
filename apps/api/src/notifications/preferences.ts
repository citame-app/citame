import { type Database, notificationPreference } from "@sob/db";
import { sql } from "drizzle-orm";
import { clientRoot } from "../client-identity";

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

export function effectivePreference(
  rows: Pick<
    typeof notificationPreference.$inferSelect,
    "clientId" | "channel" | "category" | "enabled"
  >[],
  rootId: string,
  channel: Channel,
  category: Category,
) {
  const choices = rows.filter((row) => row.channel === channel && row.category === category);
  const root = choices.find((row) => row.clientId === rootId);
  return (
    (root?.enabled ?? DEFAULT_PREFERENCES[channel][category]) &&
    !choices.some((row) => !row.enabled)
  );
}

export async function isEnabled(
  db: Pick<Database, "select">,
  clientId: string,
  channel: Channel,
  category: Category,
): Promise<boolean> {
  const root = await clientRoot(db, clientId);
  const rows = await db
    .select()
    .from(notificationPreference)
    .where(
      sql`${notificationPreference.clientId} in(select client_identity_ids(${root.id}::uuid))`,
    );
  return effectivePreference(rows, root.id, channel, category);
}
