import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CampaignSmsTestReview,
  CampaignTestReceipt,
  CampaignTestRequest,
  CampaignTestSms,
} from "@sob/contracts";
import { auditLog, type Database, user } from "@sob/db";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AppDeps } from "../../app";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { createSmtpProvider } from "../../notifications/providers/smtp";
import { createTwilioProvider } from "../../notifications/providers/twilio";
import { PermanentProviderError } from "../../notifications/providers/types";
import type { Tx } from "../../tx";
import { getSalonSettings } from "../settings/service";
import { renderCampaignMessage } from "./message";
import { campaignRow } from "./service";

type Status = Exclude<CampaignTestReceipt["status"], "not_requested">;
export type CampaignTestChannel = "email" | "sms";

const actionsByChannel: Record<CampaignTestChannel, Record<Status, string>> = {
  email: {
    pending: "marketing.campaign_test_requested",
    accepted: "marketing.campaign_test_accepted",
    unconfirmed: "marketing.campaign_test_unconfirmed",
    rejected: "marketing.campaign_test_rejected",
  },
  sms: {
    pending: "marketing.campaign_sms_test_requested",
    accepted: "marketing.campaign_sms_test_accepted",
    unconfirmed: "marketing.campaign_sms_test_unconfirmed",
    rejected: "marketing.campaign_sms_test_rejected",
  },
};

function campaignTestSmsConfig({ config, disableProviderTests }: AppDeps) {
  const { sms, campaignTestSmsTo } = config.notifications;
  const { provider, from, authToken, accountSid } = sms;
  if (
    disableProviderTests ||
    provider !== "twilio" ||
    !from ||
    !authToken ||
    !accountSid ||
    !campaignTestSmsTo
  )
    return undefined;
  return { to: campaignTestSmsTo, from, authToken, accountSid };
}

function campaignTestEmailAvailable({ config, disableProviderTests }: AppDeps) {
  const { email } = config.notifications;
  return !disableProviderTests && email.provider === "smtp" && Boolean(email.smtpUrl);
}

async function verifiedCampaignEmailRecipient(db: Database | Tx, userId: string, lock = false) {
  const query = db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.role, "owner"), eq(user.emailVerified, true)));
  const [recipient] = await (lock ? query.for("share") : query);
  return recipient;
}

export async function canTestCampaignEmail(deps: AppDeps, principal: Principal) {
  return (
    principal.role === "owner" &&
    campaignTestEmailAvailable(deps) &&
    Boolean(await verifiedCampaignEmailRecipient(deps.db, principal.userId))
  );
}

function smsReviewToken(
  deps: AppDeps,
  principal: Principal,
  draft: { id: string; version: number; smsBody: string },
  phone: string,
) {
  return createHmac("sha256", deps.config.notifications.signingSecret)
    .update(
      JSON.stringify([
        "campaign-sms-test-v1",
        deps.config.syncReplicaGeneration,
        principal.userId,
        draft.id,
        draft.version,
        draft.smsBody,
        phone,
      ]),
    )
    .digest("hex");
}

export async function reviewCampaignTestSms(
  deps: AppDeps,
  principal: Principal,
  id: string,
  version: number,
): Promise<CampaignSmsTestReview | undefined> {
  const sms = campaignTestSmsConfig(deps);
  if (
    !sms ||
    principal.role !== "owner" ||
    !(await verifiedCampaignEmailRecipient(deps.db, principal.userId))
  )
    return undefined;
  const draft = await campaignRow(deps.db, id);
  if (
    draft.version !== version ||
    draft.channel === "email" ||
    draft.status !== "draft" ||
    !draft.smsBody
  )
    return undefined;
  return {
    lastFour: sms.to.slice(-4),
    message: draft.smsBody,
    reviewToken: smsReviewToken(deps, principal, draft, sms.to),
    generation: deps.config.syncReplicaGeneration,
  };
}

async function testAttempt(
  tx: Tx,
  scope: { actorUserId: string; entity: string; entityId: string },
  actionFor: Record<Status, string>,
  filter: { requestId: string } | { version: number; smsReviewKey?: string },
  now?: number,
) {
  const metadata = sql`(case when jsonb_typeof(${auditLog.metadata}) = 'string'
      then (${auditLog.metadata} #>> '{}')::jsonb else ${auditLog.metadata} end)`;
  const interruptedBefore =
    now === undefined
      ? sql`clock_timestamp() - interval '5 minutes'`
      : sql`${new Date(now - 5 * 60_000)}`;
  const [attempt] = await tx
    .select({
      action: auditLog.action,
      metadata: auditLog.metadata,
      interrupted: sql<boolean>`${auditLog.createdAt} < ${interruptedBefore}`,
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
          : and(
              sql`${metadata}->>'version' = ${String(filter.version)}`,
              filter.smsReviewKey
                ? sql`${metadata}->>'smsReviewKey' = ${filter.smsReviewKey}`
                : undefined,
            ),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  if (!attempt) return undefined;
  const status = (Object.keys(actionFor) as Status[]).find(
    (key) => actionFor[key] === attempt.action,
  );
  const { version, requestId, smsReviewKey } = attempt.metadata;
  if (!status || typeof requestId !== "string") throw new Error("Unexpected campaign test state");
  return {
    version,
    requestId,
    smsReviewKey,
    status: status === "pending" && attempt.interrupted ? "unconfirmed" : status,
  } as const;
}

export async function requestCampaignTest(
  deps: AppDeps,
  principal: Principal,
  id: string,
  channel: CampaignTestChannel,
  input: CampaignTestRequest | CampaignTestSms,
): Promise<CampaignTestReceipt | { retryAfterSeconds: number }> {
  requireRole(principal, "owner");
  const { db, config, rateLimitNow } = deps;
  const notification = config.notifications;
  const { email } = notification;
  const smsConfig = channel === "sms" ? campaignTestSmsConfig(deps) : undefined;
  if (channel === "email" && !campaignTestEmailAvailable(deps))
    throw new DomainError("invalid_state", "Commercial email tests are unavailable");
  if (channel === "sms" && !smsConfig)
    throw new DomainError("invalid_state", "Commercial SMS tests are unavailable");
  const actionFor = actionsByChannel[channel];
  const smsReviewKey =
    smsConfig && "reviewToken" in input
      ? createHash("sha256").update(input.reviewToken).digest("hex")
      : undefined;

  const audit = {
    actorUserId: principal.userId,
    entity: "marketing_campaign",
    entityId: id,
    metadata: {
      version: input.version,
      requestId: input.requestId,
      ...(smsReviewKey && { smsReviewKey }),
    },
  };
  const claim = await db.transaction(async (tx) => {
    const draft = await campaignRow(tx, id, true);
    const recipient = await verifiedCampaignEmailRecipient(tx, principal.userId, true);
    if (!recipient) throw new DomainError("forbidden", "Verify the owner email to send a test");
    if (draft.version !== input.version)
      throw new DomainError("version_conflict", "The campaign changed; reload the draft");
    const contentReady =
      channel === "email"
        ? draft.channel !== "sms" && draft.subject && draft.emailBody
        : draft.channel !== "email" && draft.smsBody;
    if (draft.status !== "draft" || !contentReady)
      throw new DomainError(
        "invalid_state",
        channel === "email"
          ? "Save an email draft with a subject and message"
          : "Save an SMS draft with a message",
      );
    if (smsConfig) {
      const expected = Buffer.from(smsReviewToken(deps, principal, draft, smsConfig.to), "hex");
      const provided = Buffer.from("reviewToken" in input ? input.reviewToken : "", "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        throw new DomainError(
          "version_conflict",
          "Review the saved SMS and test destination again",
        );
    }

    const checkedAt = rateLimitNow?.();
    const repeated = await testAttempt(
      tx,
      audit,
      actionFor,
      { requestId: input.requestId },
      checkedAt,
    );
    if (repeated) {
      if (repeated.version !== input.version || repeated.smsReviewKey !== smsReviewKey)
        throw new DomainError("version_conflict", "Review this campaign version again");
      return { status: repeated.status, requestId: repeated.requestId };
    }
    if (input.mode === "check")
      return { status: "not_requested" as const, requestId: input.requestId };
    const previous = await testAttempt(
      tx,
      audit,
      actionFor,
      { version: input.version, smsReviewKey },
      checkedAt,
    );
    if (
      smsConfig &&
      input.mode === "replace_unconfirmed" &&
      (previous?.status !== "unconfirmed" ||
        !("replacesRequestId" in input) ||
        previous.requestId !== input.replacesRequestId)
    ) {
      return {
        status: previous?.status ?? "not_requested",
        requestId: previous?.requestId ?? input.requestId,
      } as const;
    }
    if (
      previous?.status === "pending" ||
      (previous?.status === "unconfirmed" && input.mode !== "replace_unconfirmed")
    )
      return { status: previous.status, requestId: previous.requestId };
    const salon = await getSalonSettings(tx);
    // Serialize claims across this owner's drafts. Audit rows hold each channel's quota.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`marketing-campaign-test:${principal.userId}`}, 0))`,
    );
    const now =
      rateLimitNow?.() ??
      (
        await tx.execute<{ now: number }>(
          sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as now`,
        )
      )[0]?.now;
    if (now === undefined) throw new Error("Campaign test could not read the database clock");
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
  let status: Status;
  try {
    if (channel === "email" && email.smtpUrl) {
      const provider = createSmtpProvider({ url: email.smtpUrl, from: email.from });
      try {
        await provider.send({
          to: recipient.email,
          subject: `[Prueba / Test] ${message.subject}`,
          text: message.text,
          html: message.html,
          idempotencyKey: input.requestId,
        });
      } finally {
        await provider.close?.();
      }
    } else if (smsConfig) {
      const provider = createTwilioProvider({
        ...smsConfig,
        fetch: deps.smsFetch,
      });
      await provider.send({
        to: smsConfig.to,
        body: `[Prueba / Test] ${message.sms}`,
        idempotencyKey: input.requestId,
      });
    } else throw new Error("Campaign test provider missing");
    status = "accepted";
  } catch (error) {
    status = error instanceof PermanentProviderError ? "rejected" : "unconfirmed";
  }
  await recordAudit(db, {
    ...audit,
    action: actionFor[status],
    createdAt: rateLimitNow ? new Date(rateLimitNow()) : undefined,
  });
  return { status, requestId: input.requestId };
}
