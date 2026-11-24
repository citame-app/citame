import { createHash } from "node:crypto";
import type { CampaignDraft } from "@sob/contracts";
import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { getSalonSettings } from "../settings/service";
import { commercialPermissionSql } from "./consent";

type Connection = Database | Tx;
export const MAX_CAMPAIGN_RECIPIENTS = 10000;
export function marketingCapabilities(config: NotificationConfig) {
  return {
    email: config.email.provider === "smtp" && Boolean(config.email.smtpUrl),
    sms:
      config.sms.provider === "twilio" &&
      Boolean(config.sms.accountSid && config.sms.authToken && config.sms.from),
    worker: config.workerEnabled || config.externalWorkerEnabled === true,
  };
}
export type AudienceRecipient = {
  clientId: string;
  name: string;
  channel: "email" | "sms";
  occurrence: string;
};
type Candidate = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  email_allowed: boolean;
  sms_allowed: boolean;
  last_id: string | null;
  first_id: string | null;
  first_at: Date | null;
  last_at: Date | null;
  visits: number;
  birthday: { month?: number; day?: number } | null;
};
const validEmail = z.email();
const normalizedPhone = (value: string | null) => value?.replace(/[\s().-]/g, "") ?? "";
export async function campaignAudience(
  db: Connection,
  campaign: Pick<
    CampaignDraft,
    "audience" | "channel" | "trigger" | "delayMinutes" | "birthdayLeadDays"
  > & { id: string; version: number; activatedAt?: Date | null },
  capabilities: ReturnType<typeof marketingCapabilities>,
  now: Date,
) {
  const inactiveDays = campaign.audience.inactiveDays;
  const tags = campaign.audience.tags;
  const selectedIds = campaign.audience.selectedClientIds;
  const rows = await db.execute<Candidate>(sql`
    with visits as (
      select client_root_id(client_id) as client_id,count(*)::int as visits,min(ends_at) as first_at,max(ends_at) as last_at,
      (array_agg(id order by ends_at,id))[1] as first_id,(array_agg(id order by ends_at desc,id desc))[1] as last_id
      from appointment where status='completed' and deleted_at is null and ends_at<=${now} group by client_root_id(client_id)
    )
    select c.id,c.name,c.email,c.phone,v.visits,v.first_at,v.last_at,v.first_id,v.last_id,c.contact_details->'birthday' as birthday,
      (${commercialPermissionSql(sql`c.id`, "email")}) as email_allowed,
      (${commercialPermissionSql(sql`c.id`, "sms")}) as sms_allowed
    from client_profile c left join visits v on v.client_id=c.id
    where c.deleted_at is null and c.merged_into_id is null
      ${
        selectedIds
          ? sql`and c.id in (${sql.join(
              selectedIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
      ${
        tags.length
          ? sql`and c.tags && array[${sql.join(
              tags.map((tag) => sql`${tag}`),
              sql`, `,
            )}]::text[]`
          : sql``
      }
      ${inactiveDays !== null ? sql`and v.last_at <= ${new Date(now.getTime() - inactiveDays * 86400000)}` : sql``}
      ${campaign.audience.noFutureAppointments ? sql`and not exists(select 1 from appointment f where f.client_id in(select client_identity_ids(c.id)) and f.status='booked' and f.deleted_at is null and f.ends_at>${now})` : sql``}
    order by c.id limit ${MAX_CAMPAIGN_RECIPIENTS + 1}
  `);
  if (rows.length > MAX_CAMPAIGN_RECIPIENTS)
    throw new DomainError(
      "validation_error",
      "Narrow the campaign audience to at most 10,000 clients",
    );
  const recipients: AudienceRecipient[] = [];
  const destinations = new Set<string>();
  const settings = campaign.trigger === "birthday" ? await getSalonSettings(db) : null;
  // The injected clock owns the local birthday calculation; no host-timezone dependency.
  const birthdayTarget = settings
    ? Temporal.Instant.fromEpochMilliseconds(now.getTime())
        .toZonedDateTimeISO(settings.timezone)
        .toPlainDate()
        .add({ days: campaign.birthdayLeadDays })
    : null;
  for (const row of rows) {
    let occurrence = "once";
    if (campaign.trigger === "first_visit") {
      if (row.visits !== 1 || !row.first_id || !row.first_at) continue;
      const at = new Date(row.first_at).getTime();
      if (at + campaign.delayMinutes * 60000 > now.getTime()) continue;
      if (campaign.activatedAt && at < campaign.activatedAt.getTime()) continue;
      occurrence = `first:${row.first_id}`;
    } else if (campaign.trigger === "inactive") {
      if (
        !row.last_id ||
        !row.last_at ||
        new Date(row.last_at).getTime() + campaign.delayMinutes * 60000 > now.getTime()
      )
        continue;
      occurrence = `inactive:${row.last_id}`;
    } else if (campaign.trigger === "birthday") {
      if (
        !birthdayTarget ||
        row.birthday?.month !== birthdayTarget.month ||
        row.birthday?.day !== birthdayTarget.day
      )
        continue;
      occurrence = `birthday:${birthdayTarget.year}`;
    }
    const email =
      capabilities.email && row.email_allowed && validEmail.safeParse(row.email).success;
    const sms =
      capabilities.sms && row.sms_allowed && /^\+[1-9]\d{7,14}$/.test(normalizedPhone(row.phone));
    const channel =
      campaign.channel === "optimized"
        ? email
          ? "email"
          : sms
            ? "sms"
            : null
        : campaign.channel === "email"
          ? email
            ? "email"
            : null
          : sms
            ? "sms"
            : null;
    if (channel) {
      const address =
        channel === "email" ? row.email!.trim().toLowerCase() : normalizedPhone(row.phone);
      const key = `${channel}:${address}:${occurrence}`;
      if (destinations.has(key)) continue;
      destinations.add(key);
      recipients.push({ clientId: row.id, name: row.name, channel, occurrence });
    }
  }
  const audienceHash = createHash("sha256")
    .update(
      JSON.stringify({
        id: campaign.id,
        version: campaign.version,
        recipients: recipients.map(({ clientId, channel, occurrence }) => ({
          clientId,
          channel,
          occurrence,
        })),
      }),
    )
    .digest("hex");
  return {
    recipients,
    excluded: (selectedIds?.length ?? rows.length) - recipients.length,
    audienceHash,
  };
}
