import { appointment, type Database, marketingCampaign, marketingDelivery } from "@sob/db";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { clientRoot } from "../../client-identity";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import type { Providers } from "../../notifications/providers";
import { PermanentProviderError } from "../../notifications/providers/types";
import type { NotificationWorker } from "../../notifications/worker";
import { reviewEmailTarget, reviewRequestLink } from "../reputation/reviews";
import { getSalonSettings } from "../settings/service";
import { campaignAudience, marketingCapabilities } from "./audience";
import { consentFor } from "./consent";
import { signMarketingOptOut } from "./tokens";

type DeliveryRow = typeof marketingDelivery.$inferSelect;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
export function renderCampaignMessage(input: {
  subject: string;
  emailBody: string;
  smsBody: string;
  name: string;
  firstName?: string;
  salonName: string;
  bookingUrl: string;
  unsubscribeUrl: string;
  reviewUrl?: string;
}) {
  const replace = (text: string) =>
    text.replace(/\{\{(first_name|salon_name|booking_url)\}\}/g, (_, key: string) =>
      key === "first_name"
        ? input.firstName || input.name
        : key === "salon_name"
          ? input.salonName
          : input.bookingUrl,
    );
  const body = replace(input.emailBody);
  const reviewText = input.reviewUrl ? `\n\n${input.reviewUrl}` : "";
  const reviewLink = input.reviewUrl
    ? `<p><a href="${escapeHtml(input.reviewUrl)}">${escapeHtml(input.reviewUrl)}</a></p>`
    : "";
  return {
    subject: replace(input.subject).replace(/[\r\n]/g, " "),
    text: `${body}${reviewText}\n\nUnsubscribe / Darse de baja: ${input.unsubscribeUrl}`,
    html: `<!doctype html><html><body><p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>${reviewLink}<p><a href="${escapeHtml(input.unsubscribeUrl)}">Unsubscribe / Darse de baja</a></p></body></html>`,
    sms: `${replace(input.smsBody)}\n${input.unsubscribeUrl}`,
  };
}

export function createMarketingWorker(options: {
  db: Database;
  config: NotificationConfig;
  providers: Providers;
  now?: () => Date;
  workerId?: string;
  log?: (entry: Record<string, unknown>) => void;
}): NotificationWorker {
  const { db, config, providers } = options;
  const clock = options.now ?? (() => new Date());
  const workerId = options.workerId ?? crypto.randomUUID();
  const log = options.log ?? (() => {});
  const capabilities = marketingCapabilities(config);
  const leaseMs = config.visibilityTimeoutSeconds * 1000;
  const finish = (row: DeliveryRow, fields: Partial<typeof marketingDelivery.$inferInsert>) =>
    db
      .update(marketingDelivery)
      .set({ ...fields, lockedBy: null, lockedUntil: null })
      .where(
        and(
          eq(marketingDelivery.id, row.id),
          eq(marketingDelivery.status, "processing"),
          eq(marketingDelivery.lockedBy, workerId),
        ),
      );

  async function expandAutomations(now: Date) {
    await db.transaction(async (tx) => {
      const campaigns = await tx
        .select()
        .from(marketingCampaign)
        .where(
          and(
            eq(marketingCampaign.status, "active"),
            lte(marketingCampaign.scheduledFor, now),
            or(
              isNull(marketingCampaign.evaluatedAt),
              lte(marketingCampaign.evaluatedAt, new Date(now.getTime() - 60000)),
            ),
          ),
        )
        .orderBy(asc(marketingCampaign.evaluatedAt), asc(marketingCampaign.id))
        .limit(5)
        .for("update", { skipLocked: true });
      for (const campaign of campaigns) {
        const audience = await campaignAudience(tx, campaign, capabilities, now);
        const occurrences = [...new Set(audience.recipients.map((row) => row.occurrence))];
        const known = occurrences.length
          ? await tx
              .select({
                clientId: sql<string>`client_root_id(${marketingDelivery.clientId})`,
                occurrence: marketingDelivery.occurrence,
              })
              .from(marketingDelivery)
              .where(
                and(
                  eq(marketingDelivery.campaignId, campaign.id),
                  inArray(marketingDelivery.occurrence, occurrences),
                ),
              )
          : [];
        const delivered = new Set(known.map((row) => `${row.clientId}:${row.occurrence}`));
        const recipients = audience.recipients.filter(
          (row) => !delivered.has(`${row.clientId}:${row.occurrence}`),
        );
        for (let offset = 0; offset < recipients.length; offset += 500)
          await tx
            .insert(marketingDelivery)
            .values(
              recipients.slice(offset, offset + 500).map((recipient) => ({
                campaignId: campaign.id,
                clientId: recipient.clientId,
                channel: recipient.channel,
                occurrence: recipient.occurrence,
                scheduledFor: now,
              })),
            )
            .onConflictDoNothing();
        await tx
          .update(marketingCampaign)
          .set({ evaluatedAt: now, updatedAt: campaign.updatedAt })
          .where(eq(marketingCampaign.id, campaign.id));
      }
    });
  }
  async function claim(now: Date) {
    return db.transaction(async (tx) => {
      // A lost provider response is uncertain, so a crashed send is never retried automatically.
      await tx
        .update(marketingDelivery)
        .set({
          status: "unknown",
          reason: "delivery_outcome_unknown",
          lockedBy: null,
          lockedUntil: null,
        })
        .where(
          and(eq(marketingDelivery.status, "processing"), lt(marketingDelivery.lockedUntil, now)),
        );
      const due = await tx
        .select({ id: marketingDelivery.id })
        .from(marketingDelivery)
        .where(
          and(
            eq(marketingDelivery.status, "pending"),
            lte(marketingDelivery.scheduledFor, now),
            sql`exists(select 1 from marketing_campaign c where c.id=${marketingDelivery.campaignId} and c.status in ('scheduled','active'))`,
          ),
        )
        .orderBy(asc(marketingDelivery.scheduledFor), asc(marketingDelivery.id))
        .limit(config.batchSize)
        .for("update", { skipLocked: true });
      if (!due.length) return [];
      return tx
        .update(marketingDelivery)
        .set({
          status: "processing",
          lockedBy: workerId,
          lockedUntil: new Date(now.getTime() + leaseMs),
        })
        .where(
          inArray(
            marketingDelivery.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
    });
  }
  async function handle(row: DeliveryRow) {
    let renew: ReturnType<typeof setInterval> | undefined;
    try {
      const [campaign] = await db
        .select()
        .from(marketingCampaign)
        .where(eq(marketingCampaign.id, row.campaignId));
      if (!campaign || !["scheduled", "active"].includes(campaign.status)) {
        await finish(row, { status: "cancelled", reason: "campaign_cancelled" });
        return;
      }
      if (campaign.purpose === "review_request" && !row.reviewAppointmentId) {
        await finish(row, { status: "skipped", reason: "review_eligibility_changed" });
        return;
      }
      const { client, permission } = await db.transaction(
        async (tx) => {
          const client = await clientRoot(tx, row.clientId);
          const permission = client.id === row.clientId ? await consentFor(tx, client.id) : null;
          return { client, permission };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      if (client.id !== row.clientId) {
        await finish(row, { status: "skipped", reason: "client_identity_changed" });
        return;
      }
      if (!permission?.[row.channel].enabled) {
        await finish(row, { status: "skipped", reason: "marketing_permission_withdrawn" });
        return;
      }
      const provider = row.channel === "email" ? providers.email : providers.sms;
      let raw =
        row.channel === "email" ? client.email?.trim() : client.phone?.replace(/[\s().-]/g, "");
      if (!provider || !raw) {
        await finish(row, {
          status: "skipped",
          reason: !provider ? "channel_disabled" : "no_contact_address",
        });
        return;
      }
      if (row.channel === "sms" && !/^\+[1-9]\d{7,14}$/.test(raw)) {
        await finish(row, { status: "skipped", reason: "invalid_phone" });
        return;
      }
      if (campaign.audience.noFutureAppointments) {
        const [future] = await db
          .select({ id: appointment.id })
          .from(appointment)
          .where(
            and(
              sql`${appointment.clientId} in(select client_identity_ids(${client.id}::uuid))`,
              eq(appointment.status, "booked"),
              isNull(appointment.deletedAt),
              sql`${appointment.endsAt}>${clock()}`,
            ),
          )
          .limit(1);
        if (future) {
          await finish(row, { status: "skipped", reason: "client_has_future_booking" });
          return;
        }
      }
      if (campaign.trigger === "first_visit" || campaign.trigger === "inactive") {
        const visits = await db
          .select({ id: appointment.id, endsAt: appointment.endsAt })
          .from(appointment)
          .where(
            and(
              sql`${appointment.clientId} in(select client_identity_ids(${client.id}::uuid))`,
              eq(appointment.status, "completed"),
              isNull(appointment.deletedAt),
            ),
          )
          .orderBy(asc(appointment.endsAt), asc(appointment.id));
        const target =
          campaign.trigger === "first_visit"
            ? visits.length === 1
              ? visits[0]
              : undefined
            : visits.at(-1);
        const prefix = campaign.trigger === "first_visit" ? "first" : "inactive";
        if (
          !target ||
          row.occurrence !== `${prefix}:${target.id}` ||
          target.endsAt.getTime() + campaign.delayMinutes * 60000 > clock().getTime()
        ) {
          await finish(row, { status: "skipped", reason: "automation_condition_changed" });
          return;
        }
      }
      const salon = await getSalonSettings(db);
      const token = signMarketingOptOut(config.signingSecret, {
        clientId: client.id,
        channel: row.channel,
      });
      const unsubscribeUrl = `${config.publicUrl}/marketing/opt-out?token=${token}`;
      const rendered = renderCampaignMessage({
        ...campaign,
        name: client.name,
        firstName: client.contactDetails.firstName,
        salonName: salon.name,
        bookingUrl: `${config.publicUrl}/book`,
        reviewUrl: row.reviewAppointmentId
          ? reviewRequestLink(config.publicUrl, row.reviewAppointmentId)
          : undefined,
        unsubscribeUrl,
      });
      renew = setInterval(
        () => {
          void db
            .update(marketingDelivery)
            .set({ lockedUntil: new Date(clock().getTime() + leaseMs) })
            .where(
              and(
                eq(marketingDelivery.id, row.id),
                eq(marketingDelivery.status, "processing"),
                eq(marketingDelivery.lockedBy, workerId),
              ),
            )
            .catch(() => {});
        },
        Math.max(10, Math.floor(leaseMs / 3)),
      );
      const owned = await db
        .update(marketingDelivery)
        .set({ lockedUntil: new Date(clock().getTime() + leaseMs) })
        .where(
          and(
            eq(marketingDelivery.id, row.id),
            eq(marketingDelivery.status, "processing"),
            eq(marketingDelivery.lockedBy, workerId),
          ),
        )
        .returning({ id: marketingDelivery.id });
      if (!owned.length) return;
      if (row.reviewAppointmentId) {
        const target = await reviewEmailTarget(db, row.reviewAppointmentId, clock());
        if (target?.clientId !== row.clientId || !target.email?.trim()) {
          await finish(row, { status: "skipped", reason: "review_eligibility_changed" });
          return;
        }
        raw = target.email.trim();
      }
      const result =
        row.channel === "email"
          ? await providers.email!.send({
              to: raw,
              subject: rendered.subject,
              text: rendered.text,
              html: rendered.html,
              headers: {
                "List-Unsubscribe": `<${config.publicUrl}/api/marketing/opt-out?token=${token}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
              idempotencyKey: row.id,
            })
          : await providers.sms!.send({ to: raw, body: rendered.sms, idempotencyKey: row.id });
      await finish(row, {
        status: "sent",
        sentAt: clock(),
        providerMessageId: result.messageId,
        reason: null,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") {
        await finish(row, { status: "skipped", reason: "client_archived" });
        return;
      }
      const status = error instanceof PermanentProviderError ? "failed" : "unknown";
      await finish(row, {
        status,
        reason: status === "failed" ? "provider_rejected" : "delivery_outcome_unknown",
      });
      log({ component: "marketing", deliveryId: row.id, campaignId: row.campaignId, status });
    } finally {
      if (renew) clearInterval(renew);
    }
  }
  let draining = false;

  async function releaseUnstarted(rows: DeliveryRow[]) {
    await db.transaction(async (tx) => {
      // Serialize with campaign cancellation, which locks the campaign before withdrawing deliveries.
      const campaigns = await tx
        .select({ id: marketingCampaign.id, status: marketingCampaign.status })
        .from(marketingCampaign)
        .where(inArray(marketingCampaign.id, [...new Set(rows.map((row) => row.campaignId))]))
        .orderBy(marketingCampaign.id)
        .for("update");
      const active = inArray(
        marketingDelivery.campaignId,
        campaigns
          .filter(({ status }) => status === "active" || status === "scheduled")
          .map(({ id }) => id),
      );
      await tx
        .update(marketingDelivery)
        .set({
          status: sql`case when ${active} then 'pending' else 'cancelled' end`,
          reason: sql`case when ${active} then null else 'campaign_cancelled' end`,
          lockedBy: null,
          lockedUntil: null,
        })
        .where(
          and(
            inArray(
              marketingDelivery.id,
              rows.map(({ id }) => id),
            ),
            eq(marketingDelivery.status, "processing"),
            eq(marketingDelivery.lockedBy, workerId),
          ),
        );
    });
  }

  async function runOnce() {
    if (draining) return 0;
    const now = clock();
    await expandAutomations(now);
    if (draining) return 0;
    const rows = await claim(now);
    // A batch can wait behind a slow provider. Keep every waiting lease alive as well.
    const heartbeat = rows.length
      ? setInterval(
          () => {
            void db
              .update(marketingDelivery)
              .set({ lockedUntil: new Date(clock().getTime() + leaseMs) })
              .where(
                and(
                  inArray(
                    marketingDelivery.id,
                    rows.map((row) => row.id),
                  ),
                  eq(marketingDelivery.status, "processing"),
                  eq(marketingDelivery.lockedBy, workerId),
                ),
              )
              .catch(() => {});
          },
          Math.max(10, Math.floor(leaseMs / 3)),
        )
      : null;
    try {
      for (const [index, row] of rows.entries()) {
        if (draining) {
          await releaseUnstarted(rows.slice(index));
          break;
        }
        await handle(row);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    await db
      .update(marketingCampaign)
      .set({ status: "completed" })
      .where(
        and(
          eq(marketingCampaign.status, "scheduled"),
          sql`not exists(select 1 from marketing_delivery d where d.campaign_id=${marketingCampaign.id} and d.status in ('pending','processing'))`,
        ),
      );
    return rows.length;
  }
  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  return {
    workerId,
    runOnce,
    start() {
      if (running) return;
      draining = false;
      running = true;
      loop = (async () => {
        while (running) {
          let handled = 0;
          try {
            handled = await runOnce();
          } catch {
            log({ component: "marketing", workerId, status: "poll_failed" });
          }
          if (running && handled < config.batchSize)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, config.pollIntervalMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          wake = undefined;
        }
      })();
    },
    async stop() {
      draining = true;
      running = false;
      wake?.();
      await loop;
    },
  };
}
