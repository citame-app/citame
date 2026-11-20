import { type Database, marketingCampaign, marketingDelivery } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import { marketingCapabilities } from "../marketing/audience";
import { reviewEmailTarget } from "./reviews";

export function reviewEmailEnabled(config: NotificationConfig) {
  const { email, worker } = marketingCapabilities(config);
  return email && worker;
}

export async function queueReviewEmail(
  db: Database,
  p: Principal,
  appointmentId: string,
  now: Date,
  config: NotificationConfig,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`review-email:${appointmentId}`},0))`,
    );
    const current = await loadPrincipal(tx, p.userId);
    if (!current) throw new DomainError("forbidden", "This account is no longer available");
    requirePermission(current, "editCatalog");

    const [existing] = await tx
      .select({ status: marketingDelivery.status })
      .from(marketingDelivery)
      .where(eq(marketingDelivery.reviewAppointmentId, appointmentId));
    if (existing) return existing;
    if (!reviewEmailEnabled(config))
      throw new DomainError("validation_error", "Commercial email is not configured");

    const target = await reviewEmailTarget(tx, appointmentId, now);
    if (!target?.email)
      throw new DomainError(
        "validation_error",
        "This visit is no longer eligible for a review email",
      );

    const spanish = (target.locale ?? config.defaultLocale).toLowerCase().split("-")[0] === "es";
    const [campaign] = await tx
      .insert(marketingCampaign)
      .values({
        name: spanish ? "Solicitud de reseña" : "Review request",
        purpose: "review_request",
        channel: "email",
        subject: spanish
          ? "¿Cómo fue tu visita a {{salon_name}}?"
          : "How was your visit to {{salon_name}}?",
        emailBody: spanish
          ? "Gracias por visitarnos. Si quieres compartir tu experiencia, abre tu cita para dejar una reseña."
          : "Thank you for visiting. If you’d like to share your experience, open your visit to leave a review.",
        status: "scheduled",
        scheduledFor: now,
        activatedAt: now,
        createdBy: current.userId,
        requestDigest: `review:${appointmentId}`,
      })
      .returning({ id: marketingCampaign.id });
    if (!campaign) throw new Error("Review campaign creation failed");
    const [delivery] = await tx
      .insert(marketingDelivery)
      .values({
        campaignId: campaign.id,
        clientId: target.clientId,
        channel: "email",
        occurrence: "once",
        reviewAppointmentId: appointmentId,
        scheduledFor: now,
      })
      .returning({ status: marketingDelivery.status });
    if (!delivery) throw new Error("Review email queue failed");
    await recordAudit(tx, {
      actorUserId: current.userId,
      action: "review.email_requested",
      entity: "appointment",
      entityId: appointmentId,
      metadata: { campaignId: campaign.id },
    });
    return delivery;
  });
}
