import type { CreateAppointmentRequest, Service } from "@sob/contracts";
import { intakeSubmission } from "@sob/db";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { authorizeAppointmentCreate, requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import {
  applicableIntakeForms,
  intakeHash,
  linkIntakeToAppointment,
  normalizedIntakeAnswers,
  submitIntakeResponse,
} from "./intake";

type Packet = NonNullable<CreateAppointmentRequest["intakeResponses"]>[number];
type Prepared = { principal: Principal; existing: string[]; inline: Packet[] } | null;
const required = () =>
  new DomainError("intake_required", "Review and complete the current forms before booking");

/** Called under the scheduling lock, before inserting the visit. No answer is inferred. */
export async function prepareBookingIntake(
  tx: Tx,
  request: CreateAppointmentRequest,
  clientId: string,
  actorId: string | undefined,
  now: Date,
  services: Service[],
): Promise<Prepared> {
  const forms = await applicableIntakeForms(tx, services);
  const inline = request.intakeResponses ?? [];
  const requested = request.intakeSubmissionIds ?? [];
  if (
    request.intakeReviewHash &&
    request.intakeReviewHash !== intakeHash(forms.map((form) => [form.id, form.contentHash]))
  )
    throw required();
  if (!forms.length && !inline.length && !requested.length) return null;
  if (!actorId) throw required();
  const principal = await loadPrincipal(tx, actorId);
  if (!principal) throw new DomainError("unauthorized", "The account is no longer available");
  authorizeAppointmentCreate(principal, request);
  if (principal.role === "client") {
    if (principal.clientId !== clientId)
      throw new DomainError("forbidden", "This response belongs to another client");
  } else requirePermission(principal, "editCalendar");
  const byRevision = new Map(forms.map((form) => [form.id, form]));
  const selected = new Set<string>();
  for (const packet of inline) {
    const form = byRevision.get(packet.revisionId);
    if (!form) throw required();
    if (principal.role !== "client") {
      requirePermission(principal, "editClients");
      if (!form.definition.allowTeamResponses)
        throw new DomainError("forbidden", "This form must be completed by the client");
    }
    normalizedIntakeAnswers(form.definition, packet.answers);
    selected.add(form.id);
  }
  // Bounded to the client's current revisions and the review window, including optional choices.
  const candidates = forms.length
    ? await tx
        .select()
        .from(intakeSubmission)
        .where(
          and(
            eq(intakeSubmission.clientId, clientId),
            inArray(
              intakeSubmission.revisionId,
              forms.map((form) => form.id),
            ),
            gte(intakeSubmission.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
            lte(intakeSubmission.createdAt, now),
          ),
        )
        .orderBy(desc(intakeSubmission.createdAt), desc(intakeSubmission.id))
        .limit(1000)
    : [];
  const eligible = candidates.filter(
    (row) =>
      row.source === "client" || byRevision.get(row.revisionId)?.definition.allowTeamResponses,
  );
  const existing: string[] = [];
  for (const id of requested) {
    const row = eligible.find((row) => row.id === id);
    if (!row) throw required();
    if (selected.has(row.revisionId))
      throw new DomainError("validation_error", "Choose one response per form");
    selected.add(row.revisionId);
    existing.push(row.id);
  }
  for (const form of forms) {
    if (!form.definition.requiredAtBooking || selected.has(form.id)) continue;
    const row = eligible.find((row) => row.revisionId === form.id);
    if (!row) throw required();
    selected.add(form.id);
    existing.push(row.id);
  }
  return { principal, existing, inline };
}

export async function recordBookingIntake(
  tx: Tx,
  prepared: Prepared,
  clientId: string,
  appointmentId: string,
  now: Date,
) {
  if (!prepared) return;
  for (const id of prepared.existing)
    await linkIntakeToAppointment(tx, appointmentId, id, prepared.principal.userId, now);
  for (const packet of prepared.inline)
    await submitIntakeResponse(
      tx,
      clientId,
      { ...packet, appointmentId, idempotencyKey: crypto.randomUUID() },
      prepared.principal,
      now,
    );
}
