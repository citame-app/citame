import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { headSeq } from "../sync/pull";

export const operationalProbePrefix = "citame_operational_probe_";

export function isOperationalProbeDatabase(name: string) {
  return (
    name.startsWith(operationalProbePrefix) &&
    /^[0-9a-f]{16}$/.test(name.slice(operationalProbePrefix.length))
  );
}

export const syncHistoryDigest = (through: number) => sql<string>`
  (select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(c)::text, '' order by c.seq), ''), 'UTF8')), 'hex')
   from public.sync_change c where c.seq <= ${through})
`;

const absentTables = [
  "user",
  "account",
  "session",
  "verification",
  "desktop_device",
  "oauth_client",
  "oauth_resource",
  "oauth_client_resource",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_client_assertion",
  "jwks",
  "reminder",
  "account_email_outbox",
  "marketing_campaign",
  "marketing_delivery",
  "whatsapp_connection",
  "email_delivery",
  "pass_mandate",
] as const;

/** Check the private source before preparing a copy for a separate installation. */
export async function assertBooksyCopySource(tx: Tx) {
  const occupied = sql.join(
    absentTables.map((name) => sql`exists (select 1 from public.${sql.identifier(name)})`),
    sql` or `,
  );
  const [report] = await tx.execute<{ allowed: boolean; occupied: boolean }>(sql`
    select
      (select array_agg(nspname::text order by nspname::text)
       from pg_catalog.pg_namespace
       where nspname !~ '^pg_' and nspname <> 'information_schema')
        = array['booksy_rehearsal', 'drizzle', 'public']::text[]
      and not exists (select 1 from pg_catalog.pg_largeobject_metadata)
      and not exists (select 1 from pg_catalog.pg_extension where extname not in ('plpgsql', 'btree_gist'))
      and not exists (select 1 from pg_catalog.pg_publication)
      and not exists (select 1 from pg_catalog.pg_subscription)
      and not exists (select 1 from pg_catalog.pg_event_trigger)
      and not exists (select 1 from pg_catalog.pg_foreign_data_wrapper)
      and not exists (select 1 from pg_catalog.pg_default_acl)
      as allowed,
      (${occupied}) as occupied
  `);
  if (!report?.allowed)
    throw new Error("Unexpected schemas or database objects in the copy source");
  if (report.occupied !== false)
    throw new Error("The copy source contains access credentials or delivery configuration");
}

async function readBookingControls(db: Database, through: number) {
  const [row] = await db.execute<{
    database: string;
    publicBooking: boolean;
    settings: string;
    history: string;
    appended: number;
    settingsEvents: number;
  }>(sql`
    select current_database() as database, s.online_booking_enabled as "publicBooking",
      (to_jsonb(s) - 'online_booking_enabled')::text as settings,
      ${syncHistoryDigest(through)} as history,
      (select count(*)::int from public.sync_change c where c.seq > ${through}) as appended,
      (select count(*)::int from public.sync_change c where c.seq > ${through}
         and c.entity = 'salon_settings' and c.row_id = '1' and c.op = 'upsert') as "settingsEvents"
    from public.salon_settings s where s.id = 1
  `);
  if (!row) throw new Error("The operational copy has no salon settings");
  return row;
}

/** Update only the public flag and verify the precise history append before using the copy. */
export async function pauseBooksyCopyBooking(db: Database) {
  const through = await headSeq(db);
  const before = await readBookingControls(db, through);
  if (!isOperationalProbeDatabase(before.database))
    throw new Error("Public booking can only be paused on the disposable operational copy");
  await db.execute(sql`update public.salon_settings set online_booking_enabled = false
    where id = 1 and online_booking_enabled`);
  const after = await readBookingControls(db, through);
  const expectedEvents = before.publicBooking ? 1 : 0;
  if (
    after.publicBooking !== false ||
    after.settings !== before.settings ||
    after.history !== before.history ||
    after.appended !== expectedEvents ||
    after.settingsEvents !== expectedEvents
  )
    throw new Error("Pausing public booking changed settings or sync history unexpectedly");
}
