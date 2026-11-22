import { campaignTestEmailReceiptSchema, campaignTestEmailSchema, idSchema } from "@sob/contracts";
import { auditLog, type Database, user } from "@sob/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppDeps } from "../../app";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { errorBody, parseOrThrow, readJson } from "../../http";
import { createProviders } from "../../notifications/providers";
import type { RateLimiter } from "../../rate-limit";
import type { Tx } from "../../tx";
import { getSalonSettings } from "../settings/service";
import { marketingCapabilities } from "./audience";
import { renderCampaignMessage } from "./message";
import { campaignRow } from "./service";

const testRequested = "marketing.campaign_test_requested";
const testAccepted = "marketing.campaign_test_accepted";

export function campaignTestEmailHandler(deps: AppDeps, limiter: RateLimiter) {
  return async (c: Context<AppEnv>) => {
    const principal = c.get("principal");
    requireRole(principal, "owner");
    const config = deps.config.notifications;
    if (deps.disableEmailDeliveryTest || !marketingCapabilities(config).email)
      throw new DomainError("invalid_state", "Commercial email tests are unavailable");

    const id = parseOrThrow(idSchema, c.req.param("id"));
    const { version, requestId } = parseOrThrow(campaignTestEmailSchema, await readJson(c));
    const [recipient] = await deps.db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(
        and(eq(user.id, principal.userId), eq(user.role, "owner"), eq(user.emailVerified, true)),
      );
    if (!recipient) throw new DomainError("forbidden", "Verify the owner email to send a test");

    const draft = await campaignRow(deps.db, id);
    if (draft.version !== version)
      throw new DomainError("version_conflict", "The campaign changed; reload the draft");
    if (draft.status !== "draft" || draft.channel === "sms" || !draft.subject || !draft.emailBody)
      throw new DomainError("invalid_state", "Save an email draft with a subject and message");

    const audit = {
      actorUserId: principal.userId,
      entity: "marketing_campaign",
      entityId: id,
      metadata: { version, requestId },
    };
    const findAttempt = async (db: Database | Tx) => {
      const [attempt] = await db
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entity, audit.entity),
            eq(auditLog.entityId, id),
            eq(auditLog.actorUserId, principal.userId),
            inArray(auditLog.action, [testAccepted, testRequested]),
            sql`(case when jsonb_typeof(${auditLog.metadata}) = 'string'
                     then (${auditLog.metadata} #>> '{}')::jsonb else ${auditLog.metadata} end)
                     ->>'requestId' = ${requestId}`,
          ),
        )
        .orderBy(sql`(${auditLog.action} = ${testAccepted}) desc`)
        .limit(1);
      return attempt;
    };
    const receipt = () => c.json(campaignTestEmailReceiptSchema.parse({ ok: true }));
    const replay = (attempt: NonNullable<Awaited<ReturnType<typeof findAttempt>>>) => {
      if (attempt.metadata.version !== version)
        throw new DomainError("version_conflict", "Review this campaign version again");
      if (attempt.action !== testAccepted)
        throw new DomainError("invalid_state", "This test was already requested; check your inbox");
      return receipt();
    };
    const previous = await findAttempt(deps.db);
    if (previous) return replay(previous);
    const budget = await limiter.hit("marketing-campaign-test", principal.userId, {
      max: 3,
      windowSeconds: 60,
    });
    if (!budget.allowed) {
      c.header("Retry-After", String(budget.retryAfterSeconds));
      return c.json(errorBody("rate_limited", "Too many email tests; try again later"), 429);
    }
    const salon = await getSalonSettings(deps.db);
    const message = renderCampaignMessage({
      ...draft,
      name: recipient.name,
      firstName: recipient.name.trim().split(/\s+/, 1)[0],
      salonName: salon.name,
      bookingUrl: `${config.publicUrl}/book`,
      unsubscribeUrl: null,
    });
    const existing = await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`marketing-test:${principal.userId}:${id}:${requestId}`}, 0))`,
      );
      const attempted = await findAttempt(tx);
      if (attempted) return attempted;
      await recordAudit(tx, { ...audit, action: testRequested });
    });
    if (existing) return replay(existing);
    const provider = createProviders(config).email;
    if (!provider) throw new DomainError("invalid_state", "Commercial email is unavailable");
    try {
      await provider.send({
        to: recipient.email,
        subject: `[Prueba / Test] ${message.subject}`,
        text: message.text,
        html: message.html,
        idempotencyKey: requestId,
      });
    } catch {
      throw new DomainError("invalid_state", "The provider did not confirm the test email");
    } finally {
      await provider.close?.();
    }
    await recordAudit(deps.db, { ...audit, action: testAccepted });
    return receipt();
  };
}
