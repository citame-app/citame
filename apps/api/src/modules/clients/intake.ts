import { createHash } from "node:crypto";
import {
  type IntakeAdminForm,
  type IntakeAnswers,
  type IntakeDefinition,
  type IntakeRevision,
  type IntakeSubmissionInput,
  intakeAnswersSchema,
  intakeDefinitionSchema,
  intakeFormSummariesSchema,
  type Service,
  validateIntakeAnswers,
} from "@sob/contracts";
import {
  appointment,
  type Database,
  intakeAppointment,
  intakeForm,
  intakeRevision,
  intakeSubmission,
} from "@sob/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, ownedClientIds, ownsClient, type Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot, lockClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { getBookableServices, getServicesByIds } from "../services/service";

type Connection = Database | Tx;
type FormRow = typeof intakeForm.$inferSelect;
type RevisionRow = typeof intakeRevision.$inferSelect;
type SubmissionRow = typeof intakeSubmission.$inferSelect;
async function livePrincipal(tx: Tx, principal: Principal) {
  const current = await loadPrincipal(tx, principal.userId);
  if (!current) throw new DomainError("forbidden", "This account is no longer available");
  return current;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export const intakeHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const toIntakeRevision = (row: RevisionRow): IntakeRevision => ({
  id: row.id,
  formId: row.formId,
  number: row.number,
  contentHash: row.contentHash,
  definition: intakeDefinitionSchema.parse(row.definition),
  createdAt: row.createdAt.toISOString(),
});
async function revisionRow(db: Connection, id: string) {
  const [row] = await db.select().from(intakeRevision).where(eq(intakeRevision.id, id));
  if (!row) throw new DomainError("not_found", "Form revision not found");
  return row;
}
async function formRow(db: Connection, id: string, lock = false) {
  const query = db.select().from(intakeForm).where(eq(intakeForm.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Form not found");
  return row;
}
async function formView(db: Connection, row: FormRow): Promise<IntakeAdminForm> {
  return {
    id: row.id,
    version: row.version,
    active: row.active,
    draft: intakeDefinitionSchema.parse(row.draft),
    published: row.currentRevisionId
      ? toIntakeRevision(await revisionRow(db, row.currentRevisionId))
      : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listIntakeForms(db: Database, p: Principal) {
  requirePermission(p, "deleteClients");
  const rows = await db
    .select()
    .from(intakeForm)
    .orderBy(desc(intakeForm.updatedAt), desc(intakeForm.id));
  return { forms: await Promise.all(rows.map((row) => formView(db, row))) };
}
export async function listIntakeFormSummaries(db: Database, p: Principal) {
  requirePermission(p, "deleteClients");
  const forms = await db
    .select({
      id: intakeForm.id,
      // Earlier writers can store the document as a JSONB string.
      title: sql<string>`(case when jsonb_typeof(${intakeForm.draft}) = 'string'
        then (${intakeForm.draft} #>> '{}')::jsonb else ${intakeForm.draft} end)->>'title'`,
      active: intakeForm.active,
      publishedNumber: intakeRevision.number,
    })
    .from(intakeForm)
    .leftJoin(intakeRevision, eq(intakeForm.currentRevisionId, intakeRevision.id))
    .orderBy(desc(intakeForm.updatedAt), desc(intakeForm.id));
  return intakeFormSummariesSchema.parse({ forms });
}

export async function getIntakeForm(db: Database, id: string, p: Principal) {
  requirePermission(p, "deleteClients");
  return formView(db, await formRow(db, id));
}

export async function createIntakeForm(
  db: Database,
  input: { idempotencyKey: string; definition: IntakeDefinition },
  p: Principal,
  now: Date,
) {
  requirePermission(p, "deleteClients");
  const fingerprint = intakeHash(input.definition);
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    requirePermission(await livePrincipal(tx, p), "deleteClients");
    const [previous] = await tx
      .select()
      .from(intakeForm)
      .where(
        and(
          eq(intakeForm.createdBy, p.userId),
          eq(intakeForm.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestFingerprint !== fingerprint)
        throw new DomainError(
          "invalid_state",
          "This form identifier already belongs to another draft",
        );
      return formView(tx, previous);
    }
    const [total] = await tx.select({ count: count() }).from(intakeForm);
    if ((total?.count ?? 0) >= 100)
      throw new DomainError("storage_limit", "The form directory capacity has been reached");
    const [created] = await tx
      .insert(intakeForm)
      .values({
        draft: input.definition,
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Form insert returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "intake.form_created",
      entity: "intake_form",
      entityId: created.id,
    });
    return formView(tx, created);
  });
}
export async function updateIntakeDraft(
  db: Database,
  id: string,
  input: { version: number; definition: IntakeDefinition },
  p: Principal,
  now: Date,
) {
  requirePermission(p, "deleteClients");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    requirePermission(await livePrincipal(tx, p), "deleteClients");
    const current = await formRow(tx, id, true);
    if (current.version !== input.version)
      throw new DomainError("version_conflict", "The form changed; reload before saving");
    if (intakeHash(current.draft) === intakeHash(input.definition)) return formView(tx, current);
    const [saved] = await tx
      .update(intakeForm)
      .set({ draft: input.definition, version: current.version + 1, updatedAt: now })
      .where(eq(intakeForm.id, id))
      .returning();
    if (!saved) throw new Error("Form update returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "intake.draft_updated",
      entity: "intake_form",
      entityId: id,
      metadata: { version: saved.version },
    });
    return formView(tx, saved);
  });
}
export async function publishIntakeForm(
  db: Database,
  id: string,
  version: number,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "deleteClients");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    requirePermission(await livePrincipal(tx, p), "deleteClients");
    const current = await formRow(tx, id, true);
    if (current.version !== version)
      throw new DomainError("version_conflict", "The form changed; review before publishing");
    const definition = intakeDefinitionSchema.parse(current.draft);
    if (!definition.allServices) await getServicesByIds(tx, definition.serviceIds);
    const previous = current.currentRevisionId
      ? await revisionRow(tx, current.currentRevisionId)
      : null;
    if (previous && current.active && intakeHash(previous.definition) === intakeHash(definition))
      return formView(tx, current);
    const [active] = await tx
      .select({ count: count() })
      .from(intakeForm)
      .where(eq(intakeForm.active, true));
    if (!current.active && (active?.count ?? 0) >= 10)
      throw new DomainError("storage_limit", "Up to ten forms may be active at once");
    const number = (previous?.number ?? 0) + 1;
    const [revision] = await tx
      .insert(intakeRevision)
      .values({
        formId: id,
        number,
        title: definition.title,
        definition,
        contentHash: intakeHash({ number, definition }),
        createdBy: p.userId,
        createdAt: now,
      })
      .returning();
    if (!revision) throw new Error("Revision insert returned no row");
    const [saved] = await tx
      .update(intakeForm)
      .set({
        currentRevisionId: revision.id,
        active: true,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(intakeForm.id, id))
      .returning();
    if (!saved) throw new Error("Form publish returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "intake.form_published",
      entity: "intake_form",
      entityId: id,
      metadata: { revisionId: revision.id, number, version: saved.version },
    });
    return formView(tx, saved);
  });
}
export async function archiveIntakeForm(
  db: Database,
  id: string,
  version: number,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "deleteClients");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    requirePermission(await livePrincipal(tx, p), "deleteClients");
    const current = await formRow(tx, id, true);
    if (current.version !== version)
      throw new DomainError("version_conflict", "The form changed; review before archiving");
    if (!current.active) return formView(tx, current);
    const [saved] = await tx
      .update(intakeForm)
      .set({ active: false, version: current.version + 1, updatedAt: now })
      .where(eq(intakeForm.id, id))
      .returning();
    if (!saved) throw new Error("Form archive returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "intake.form_archived",
      entity: "intake_form",
      entityId: id,
      metadata: { version: saved.version },
    });
    return formView(tx, saved);
  });
}
export async function applicableIntakeForms(db: Connection, services: Service[]) {
  const ids = new Set(
    services.flatMap((service) =>
      service.catalog?.kind === "variant"
        ? [service.id, service.catalog.parentServiceId]
        : [service.id],
    ),
  );
  const rows = await db
    .select({ revision: intakeRevision })
    .from(intakeForm)
    .innerJoin(intakeRevision, eq(intakeRevision.id, intakeForm.currentRevisionId))
    .where(eq(intakeForm.active, true))
    .orderBy(asc(intakeForm.id));
  return rows
    .map((row) => toIntakeRevision(row.revision))
    .filter(
      (revision) =>
        revision.definition.allServices || revision.definition.serviceIds.some((id) => ids.has(id)),
    );
}
export async function getIntakeRequirements(
  db: Database,
  serviceIds: string[],
  p: Principal,
  now: Date = new Date(),
  clientId?: string,
) {
  if (p.role !== "client") requirePermission(p, "editCalendar");
  else if (!p.clientId) throw new DomainError("forbidden", "This account has no client profile");
  const services = await getBookableServices(db, serviceIds);
  const forms = await applicableIntakeForms(db, services);
  const subject = p.role === "client" ? p.clientId : clientId;
  if (p.role === "client" && clientId && clientId !== p.clientId)
    throw new DomainError("forbidden", "Only your own responses are available");
  const readyResponses: { id: string; revisionId: string; createdAt: string }[] = [];
  if (subject && forms.length) {
    authorizeSubject(p, subject);
    await activeClient(db, subject);
    const rows = await db
      .select()
      .from(intakeSubmission)
      .where(
        and(
          eq(intakeSubmission.clientId, subject),
          inArray(
            intakeSubmission.revisionId,
            forms.map((form) => form.id),
          ),
          gte(intakeSubmission.createdAt, new Date(now.getTime() - 86400000)),
          lte(intakeSubmission.createdAt, now),
        ),
      )
      .orderBy(desc(intakeSubmission.createdAt), desc(intakeSubmission.id))
      .limit(1000);
    const seen = new Set<string>();
    for (const row of rows) {
      const form = forms.find((form) => form.id === row.revisionId);
      if (
        seen.has(row.revisionId) ||
        (row.source === "team" && !form?.definition.allowTeamResponses)
      )
        continue;
      seen.add(row.revisionId);
      readyResponses.push({
        id: row.id,
        revisionId: row.revisionId,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }
  return {
    forms,
    reviewHash: intakeHash(forms.map((form) => [form.id, form.contentHash])),
    readyResponses,
  };
}
async function activeClient(db: Connection, id: string, lock = false) {
  return lock ? lockClientRoot(db as Tx, id) : clientRoot(db, id);
}
function authorizeSubject(p: Principal, clientId: string, write = false) {
  if (p.role === "client") {
    if (!p.clientId || !ownsClient(p, clientId))
      throw new DomainError("not_found", "Form response not found");
  } else requirePermission(p, write ? "editClients" : "clients");
}
export function normalizedIntakeAnswers(
  definition: IntakeDefinition,
  input: IntakeAnswers,
): IntakeAnswers {
  const issues = validateIntakeAnswers(definition, input);
  if (issues.length)
    throw new DomainError(
      "validation_error",
      issues.map((issue) => `${issue.fieldId}: ${issue.code}`).join("; "),
    );
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      if ((typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length))
        return [];
      return [
        [
          key,
          typeof value === "string"
            ? value.trim()
            : Array.isArray(value)
              ? [...value].sort()
              : value,
        ],
      ];
    }),
  );
}
async function submissionView(db: Connection, row: SubmissionRow) {
  return {
    id: row.id,
    clientId: row.clientId,
    appointmentId: row.appointmentId,
    source: row.source,
    confirmationVersion: row.confirmationVersion,
    createdAt: row.createdAt.toISOString(),
    answers: intakeAnswersSchema.parse(row.answers),
    revision: toIntakeRevision(await revisionRow(db, row.revisionId)),
  };
}
export async function submitIntakeResponse(
  db: Database | Tx,
  clientId: string,
  input: IntakeSubmissionInput,
  p: Principal,
  now: Date,
) {
  authorizeSubject(p, clientId, true);
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const principal = await livePrincipal(tx, p);
    authorizeSubject(principal, clientId, true);
    const subject = await activeClient(tx, clientId, true);
    const revision = await revisionRow(tx, input.revisionId);
    const definition = intakeDefinitionSchema.parse(revision.definition);
    const answers = normalizedIntakeAnswers(definition, input.answers);
    const fingerprint = intakeHash({
      clientId,
      revisionId: revision.id,
      answers,
      appointmentId: input.appointmentId ?? null,
    });
    const [previous] = await tx
      .select()
      .from(intakeSubmission)
      .where(
        and(
          eq(intakeSubmission.createdBy, p.userId),
          eq(intakeSubmission.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestFingerprint !== fingerprint)
        throw new DomainError(
          "invalid_state",
          "This response identifier already belongs to another submission",
        );
      return submissionView(tx, previous);
    }
    if (subject.id !== clientId)
      throw new DomainError(
        "client_merged",
        "Review the surviving subject before recording a new response",
      );
    const form = await formRow(tx, revision.formId);
    if (!form.active || form.currentRevisionId !== revision.id)
      throw new DomainError(
        "version_conflict",
        "Review the current published form before answering",
      );
    if (principal.role !== "client" && !definition.allowTeamResponses)
      throw new DomainError("forbidden", "This form must be completed by the client");
    if (input.appointmentId) {
      const [visit] = await tx
        .select({ id: appointment.id })
        .from(appointment)
        .where(
          and(
            eq(appointment.id, input.appointmentId),
            eq(appointment.clientId, clientId),
            isNull(appointment.deletedAt),
          ),
        );
      if (!visit) throw new DomainError("not_found", "Appointment not found");
    }
    const [clientCount] = await tx
      .select({ count: count() })
      .from(intakeSubmission)
      .where(inArray(intakeSubmission.clientId, await clientIdentityIds(tx, clientId)));
    const [total] = await tx.select({ count: count() }).from(intakeSubmission);
    if ((clientCount?.count ?? 0) >= 1000 || (total?.count ?? 0) >= 50000)
      throw new DomainError("storage_limit", "The form response storage capacity has been reached");
    const [saved] = await tx
      .insert(intakeSubmission)
      .values({
        clientId,
        revisionId: revision.id,
        answers,
        source: principal.role === "client" ? "client" : "team",
        confirmationVersion: "intake-response-v1",
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now,
      })
      .returning();
    if (!saved) throw new Error("Response insert returned no row");
    if (input.appointmentId)
      await linkIntakeToAppointment(tx, input.appointmentId, saved.id, p.userId, now);
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "intake.submitted",
      entity: "intake_submission",
      entityId: saved.id,
      metadata: { clientId, revisionId: revision.id, source: saved.source },
    });
    return submissionView(tx, { ...saved, appointmentId: input.appointmentId ?? null });
  });
}
export async function linkIntakeToAppointment(
  tx: Tx,
  appointmentId: string,
  submissionId: string,
  actorId: string,
  now: Date,
) {
  await tx
    .update(intakeSubmission)
    .set({ appointmentId })
    .where(and(eq(intakeSubmission.id, submissionId), isNull(intakeSubmission.appointmentId)));
  await tx
    .insert(intakeAppointment)
    .values({ appointmentId, submissionId, createdBy: actorId, createdAt: now })
    .onConflictDoNothing();
}
export async function getIntakeSubmission(
  db: Database,
  id: string,
  p: Principal,
  subjectId?: string,
) {
  if (subjectId) authorizeSubject(p, subjectId);
  if (p.role !== "client") requirePermission(p, "clients");
  const [row] = await db
    .select()
    .from(intakeSubmission)
    .where(
      and(
        eq(intakeSubmission.id, id),
        p.role === "client" ? inArray(intakeSubmission.clientId, ownedClientIds(p)) : undefined,
        subjectId
          ? inArray(intakeSubmission.clientId, await clientIdentityIds(db, subjectId))
          : undefined,
      ),
    );
  if (!row) throw new DomainError("not_found", "Form response not found");
  authorizeSubject(p, row.clientId);
  await activeClient(db, row.clientId);
  return submissionView(db, row);
}
export async function listIntakeSubmissions(
  db: Database,
  clientId: string,
  p: Principal,
  before?: string,
) {
  authorizeSubject(p, clientId);
  await activeClient(db, clientId);
  const { lt } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: intakeSubmission.id,
      clientId: intakeSubmission.clientId,
      appointmentId: intakeSubmission.appointmentId,
      source: intakeSubmission.source,
      createdAt: intakeSubmission.createdAt,
      revisionId: intakeRevision.id,
      formId: intakeRevision.formId,
      formTitle: intakeRevision.title,
      number: intakeRevision.number,
    })
    .from(intakeSubmission)
    .innerJoin(intakeRevision, eq(intakeRevision.id, intakeSubmission.revisionId))
    .where(
      and(
        inArray(intakeSubmission.clientId, await clientIdentityIds(db, clientId)),
        before ? lt(intakeSubmission.id, before) : undefined,
      ),
    )
    .orderBy(desc(intakeSubmission.id))
    .limit(21);
  const visible = rows.slice(0, 20);
  return {
    submissions: visible.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    nextCursor: rows.length > 20 ? (visible.at(-1)?.id ?? null) : null,
  };
}
