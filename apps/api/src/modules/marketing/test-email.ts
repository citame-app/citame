import type { CampaignTestEmail, CampaignTestEmailReceipt } from "@sob/contracts";
import { auditLog, type Database, user } from "@sob/db";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppDeps } from "../../app";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { createSmtpProvider } from "../../notifications/providers/smtp";
import { PermanentProviderError } from "../../notifications/providers/types";
import type { Tx } from "../../tx";
import { getSalonSettings } from "../settings/service";
import { renderCampaignMessage } from "./message";
import { campaignRow } from "./service";

type Status = Exclude<CampaignTestEmailReceipt["status"], "not_requested">;

const actionFor: Record<Status, string> = {
  pending: "marketing.campaign_test_requested",
  accepted: "marketing.campaign_test_accepted",
  unconfirmed: "marketing.campaign_test_unconfirmed",
  rejected: "marketing.campaign_test_rejected",
};

export async function verifiedCampaignEmailRecipient(
  db: Database | Tx,
  userId: string,
  lock = false,
) {
  const query = db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.role, "owner"), eq(user.emailVerified, true)));
  const [recipient] = await (lock ? query.for("share") : query);
  return recipient;
}

async function testAttempt(
  tx: Tx,
  scope: { actorUserId: string; entity: string; entityId: string },
  filter: { requestId: string } | { version: number },
  now: number,
) {
  const metadata = sql`(case when jsonb_typeof(${auditLog.metadata}) = 'string'
      then (${auditLog.metadata} #>> '{}')::jsonb else ${auditLog.metadata} end)`;
  const [attempt] = await tx
    .select({
      action: auditLog.action,
      metadata: auditLog.metadata,
      interrupted: sql<boolean>`${auditLog.createdAt} < ${new Date(now - 5 * 60_000)}`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, scope.entity),
        eq(auditLog.entityId, scope.entityId),
        eq(auditLog.actorUserId, scope.actorUserId),
        inArray(auditLog.action, Object.values(actionFor)),
        "requestId" in filter
          ? sql`${metadata}->>'requestId' = ${filter.requestId}`
          : sql`${metadata}->>'version' = ${String(filter.version)}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  if (!attempt) return undefined;
  const status = (Object.keys(actionFor) as Status[]).find(
    (key) => actionFor[key] === attempt.action,
  );
  const { version, requestId } = attempt.metadata;
  if (!status || typeof requestId !== "string") throw new Error("Unexpected campaign test state");
  return {
    version,
    requestId,
    status: status === "pending" && attempt.interrupted ? "unconfirmed" : status,
  } as const;
}

export async function requestCampaignTestEmail(
  { db, config, disableEmailDeliveryTest, rateLimitNow = Date.now }: AppDeps,
  principal: Principal,
  id: string,
  input: CampaignTestEmail,
): Promise<CampaignTestEmailReceipt | { retryAfterSeconds: number }> {
  requireRole(principal, "owner");
  const notification = config.notifications;
  const email = notification.email;
  if (disableEmailDeliveryTest || email.provider !== "smtp" || !email.smtpUrl)
    throw new DomainError("invalid_state", "Commercial email tests are unavailable");

  const audit = {
    actorUserId: principal.userId,
    entity: "marketing_campaign",
    entityId: id,
    metadata: { version: input.version, requestId: input.requestId },
  };
  const claim = await db.transaction(async (tx) => {
    const draft = await campaignRow(tx, id, true);
    const recipient = await verifiedCampaignEmailRecipient(tx, principal.userId, true);
    if (!recipient) throw new DomainError("forbidden", "Verify the owner email to send a test");
    if (draft.version !== input.version)
      throw new DomainError("version_conflict", "The campaign changed; reload the draft");
    if (draft.status !== "draft" || draft.channel === "sms" || !draft.subject || !draft.emailBody)
      throw new DomainError("invalid_state", "Save an email draft with a subject and message");

    const checkedAt = rateLimitNow();
    const repeated = await testAttempt(tx, audit, { requestId: input.requestId }, checkedAt);
    if (repeated) {
      if (repeated.version !== input.version)
        throw new DomainError("version_conflict", "Review this campaign version again");
      return { status: repeated.status, requestId: repeated.requestId };
    }
    if (input.mode === "check")
      return { status: "not_requested" as const, requestId: input.requestId };
    const previous = await testAttempt(tx, audit, { version: input.version }, checkedAt);
    if (
      previous?.status === "pending" ||
      (previous?.status === "unconfirmed" && input.mode !== "replace_unconfirmed")
    )
      return { status: previous.status, requestId: previous.requestId };
    const salon = await getSalonSettings(tx);
    // Serialize new claims across this owner's drafts. The audit row is the durable quota debit.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`marketing-campaign-test:${principal.userId}`}, 0))`,
    );
    const now = rateLimitNow();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const windowEnd = windowStart + 60_000;
    const claims = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, principal.userId),
          eq(auditLog.action, actionFor.pending),
          gte(auditLog.createdAt, new Date(windowStart)),
          lt(auditLog.createdAt, new Date(windowEnd)),
        ),
      )
      .limit(3);
    if (claims.length === 3) return { retryAfterSeconds: Math.ceil((windowEnd - now) / 1000) };
    await recordAudit(tx, {
      ...audit,
      action: actionFor.pending,
      createdAt: new Date(now),
    });
    return { draft, recipient, salonName: salon.name };
  });
  if (!("draft" in claim) || !claim.draft) return claim;

  const { draft, recipient, salonName } = claim;
  const message = renderCampaignMessage({
    ...draft,
    name: recipient.name,
    firstName: recipient.name.trim().split(/\s+/, 1)[0],
    salonName,
    bookingUrl: `${notification.publicUrl}/book`,
    unsubscribeUrl: null,
  });
  const provider = createSmtpProvider({ url: email.smtpUrl, from: email.from });
  let status: Status;
  try {
    await provider.send({
      to: recipient.email,
      subject: `[Prueba / Test] ${message.subject}`,
      text: message.text,
      html: message.html,
      idempotencyKey: input.requestId,
    });
    status = "accepted";
  } catch (error) {
    status = error instanceof PermanentProviderError ? "rejected" : "unconfirmed";
  } finally {
    await provider.close?.();
  }
  await recordAudit(db, {
    ...audit,
    action: actionFor[status],
    createdAt: new Date(rateLimitNow()),
  });
  return { status, requestId: input.requestId };
}
