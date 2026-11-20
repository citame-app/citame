import { createHash } from "node:crypto";
import { type BooksyTransfer, booksyTransferSchema } from "@sob/contracts";

export const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");

export function targetFingerprint(kind: string, row: Record<string, unknown>) {
  if (kind === "staff" && row.portraitAbsenceVersion === null) {
    // Additive metadata is absent in original receipts until a removal actually happens.
    const { portraitAbsenceVersion: _unused, ...originalFields } = row;
    return fingerprint(originalFields);
  }
  if (kind === "appointments") {
    // These additive columns were absent from earlier verification receipts.
    const originalFields = { ...row };
    if (originalFields.visitGroupId === null) delete originalFields.visitGroupId;
    if (originalFields.sourceBusinessMessage === null) delete originalFields.sourceBusinessMessage;
    if (originalFields.sourceStaffWindow === null) delete originalFields.sourceStaffWindow;
    if (originalFields.sourceResourceWindow === null) delete originalFields.sourceResourceWindow;
    return fingerprint(originalFields);
  }
  if (kind === "services") {
    const originalFields = { ...row };
    if (row.sortOrder === 0) delete originalFields.sortOrder;
    if (row.onlineBooking === true) delete originalFields.onlineBooking;
    if (row.clientInstructions === null) delete originalFields.clientInstructions;
    if (row.bookingIntervalMinutes === null) delete originalFields.bookingIntervalMinutes;
    if (row.priceType === "fixed") delete originalFields.priceType;
    return fingerprint(originalFields);
  }
  if (kind === "appointmentServices") {
    const originalFields = { ...row };
    if (row.priceType === "fixed") delete originalFields.priceType;
    if (row.sourceUnpriced === false) delete originalFields.sourceUnpriced;
    if (row.reviewedPriceCents === null) delete originalFields.reviewedPriceCents;
    return fingerprint(originalFields);
  }
  return fingerprint(row);
}

export function normalizedBooksyCategory(category: string | null | undefined) {
  return category?.replace(/^ +| +$/g, "") ?? null;
}

export function matchesBooksyTarget(
  kind: string,
  row: Record<string, unknown>,
  expected: string,
  sourceCategory?: string | null,
) {
  if (targetFingerprint(kind, row) === expected) return true;
  // The catalogue migration trims the live category. The archived source remains exact.
  return (
    kind === "services" &&
    typeof sourceCategory === "string" &&
    row.category === normalizedBooksyCategory(sourceCategory) &&
    targetFingerprint(kind, { ...row, category: sourceCategory }) === expected
  );
}

export function sourceUuid(business: string, kind: string, sourceId: string) {
  const hex = fingerprint([business, kind, sourceId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export interface TransferIssue {
  code: string;
  kind: string;
  sourceId?: string;
  detail: string;
}

/** Aggregate before emitting a report that must contain no customer or source record identifiers. */
export function summarizeTransferIssues(issues: readonly Pick<TransferIssue, "code" | "kind">[]) {
  const byCode = new Map<string, Map<string, number>>();
  for (const { code, kind } of issues) {
    const kinds = byCode.get(code) ?? new Map<string, number>();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    byCode.set(code, kinds);
  }
  return [...byCode]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([code, kinds]) =>
      [...kinds]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, count]) => ({ code, kind, count })),
    );
}

export function booksyAddonLinks(input: BooksyTransfer) {
  return input.services.flatMap((addon) =>
    (addon.addonParentRefs ?? []).map((ref) => ({
      addonId: sourceUuid(input.businessId, "services", addon.sourceId),
      serviceId: sourceUuid(input.businessId, "services", ref),
    })),
  );
}

export function planBooksyTransfer(raw: unknown) {
  const input = booksyTransferSchema.parse(raw);
  const issues: TransferIssue[] = [];
  const add = (code: string, kind: string, detail: string, sourceId?: string) =>
    issues.push({ code, kind, detail, ...(sourceId ? { sourceId } : {}) });
  const sets = new Map<string, Set<string>>();
  for (const [kind, rows] of Object.entries({
    staff: input.staff,
    services: input.services,
    clients: input.clients,
    appointments: input.appointments,
    hours: input.hours,
    timeOff: input.timeOff,
  })) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.sourceId))
        add("duplicate_source_id", kind, "Source identifiers must be unique", row.sourceId);
      ids.add(row.sourceId);
    }
    sets.set(kind, ids);
    const coverage = input.coverage[kind as keyof typeof input.coverage];
    if (
      coverage?.expected !== null &&
      coverage?.expected !== undefined &&
      coverage.expected !== rows.length
    )
      add("count_mismatch", kind, `Expected ${coverage.expected}, received ${rows.length}`);
  }
  const requireRef = (kind: string, id: string, ownerKind: string, ownerId: string) => {
    if (!sets.get(kind)?.has(id))
      add("missing_reference", ownerKind, `Missing ${kind} reference ${id}`, ownerId);
  };
  const from = Temporal.PlainDate.from(input.fromDate)
    .toZonedDateTime({ timeZone: input.timezone, plainTime: "00:00" })
    .toInstant().epochMilliseconds;
  const segmentIds = new Set<string>();
  let last: number | null = null;
  for (const visit of input.appointments) {
    requireRef("staff", visit.staffRef, "appointments", visit.sourceId);
    requireRef("clients", visit.clientRef, "appointments", visit.sourceId);
    const start = Date.parse(visit.startsAt),
      end = Date.parse(visit.endsAt);
    if (start < from)
      add(
        "outside_scope",
        "appointments",
        "Appointment begins before the requested local cutoff",
        visit.sourceId,
      );
    if (end <= start)
      add(
        "invalid_duration",
        "appointments",
        "Appointment must end after its start",
        visit.sourceId,
      );
    if (last === null || start > last) last = start;
    const minutes = visit.services.reduce((s, r) => s + r.durationMinutes + r.bufferMinutes, 0);
    if (start + minutes * 60_000 !== end)
      add(
        "service_plan_mismatch",
        "appointments",
        "Frozen service durations do not account for the complete appointment",
        visit.sourceId,
      );
    for (const segment of visit.services) {
      requireRef("services", segment.serviceRef, "appointments", visit.sourceId);
      if (segment.requestedStaffRef)
        requireRef("staff", segment.requestedStaffRef, "appointments", visit.sourceId);
      if (segmentIds.has(segment.sourceId))
        add(
          "duplicate_service_id",
          "appointments",
          "A booked service must belong to exactly one reservation",
          segment.sourceId,
        );
      segmentIds.add(segment.sourceId);
    }
  }
  const servicesByRef = new Map(input.services.map((row) => [row.sourceId, row]));
  for (const addon of input.services) {
    if (!addon.addonParentRefs) continue;
    if (
      addon.catalogKind !== "addon" ||
      new Set(addon.addonParentRefs).size !== addon.addonParentRefs.length ||
      addon.addonParentRefs.some((ref) => {
        const parent = servicesByRef.get(ref);
        return !parent || parent.catalogKind === "addon";
      })
    )
      add(
        "invalid_addon_eligibility",
        "services",
        "Expected distinct base services",
        addon.sourceId,
      );
  }
  for (const a of input.assignments) {
    requireRef("staff", a.staffRef, "assignments", a.staffRef);
    requireRef("services", a.serviceRef, "assignments", a.serviceRef);
  }
  for (const row of input.hours) {
    requireRef("staff", row.staffRef, "hours", row.sourceId);
    if (row.start >= row.end)
      add("invalid_hours", "hours", "Hours must end after their start", row.sourceId);
  }
  for (const row of input.timeOff) {
    requireRef("staff", row.staffRef, "timeOff", row.sourceId);
    if (Date.parse(row.endsAt) <= Date.parse(row.startsAt))
      add("invalid_duration", "timeOff", "Time off must end after its start", row.sourceId);
  }
  if (
    input.horizon.lastAppointmentAt === null
      ? input.horizon.lastAppointmentProven && last !== null
      : Date.parse(input.horizon.lastAppointmentAt) !== last
  )
    add(
      "last_appointment_mismatch",
      "appointments",
      "Declared last appointment differs from imported appointments",
    );
  const blockers: TransferIssue[] = [];
  for (const row of input.staff)
    if (row.maxConcurrent === null)
      blockers.push({
        code: "capacity_unverified",
        kind: "staff",
        sourceId: row.sourceId,
        detail:
          "Source capacity is unknown; the rehearsal uses the native default and cannot prove scheduling equivalence",
      });
  for (const [kind, coverage] of Object.entries(input.coverage))
    if (coverage.state !== "complete")
      blockers.push({ code: "coverage_incomplete", kind, detail: `Coverage is ${coverage.state}` });
  if (!input.horizon.lastAppointmentProven)
    blockers.push({
      code: "last_appointment_unproven",
      kind: "appointments",
      detail: "A last observed appointment is not proof that no later appointment exists",
    });
  for (const row of input.unprojected)
    blockers.push({
      code: "unprojected_record",
      kind: row.kind,
      sourceId: row.sourceId,
      detail: "Raw record is preserved but has no verified Citame projection",
    });
  return {
    input,
    review: {
      version: 1 as const,
      businessId: input.businessId,
      fromDate: input.fromDate,
      timezone: input.timezone,
      reviewHash: fingerprint(input),
      counts: {
        staff: input.staff.length,
        services: input.services.length,
        clients: input.clients.length,
        appointments: input.appointments.length,
        bookedServices: segmentIds.size,
        hours: input.hours.length,
        timeOff: input.timeOff.length,
        unprojected: input.unprojected.length,
      },
      lastAppointmentAt: last === null ? null : new Date(last).toISOString(),
      issues,
      blockers,
      canRehearse: issues.length === 0,
      coverageComplete: issues.length === 0 && blockers.length === 0,
      canCutOver: false,
    },
  };
}
export type TransferPlan = ReturnType<typeof planBooksyTransfer>;
export type { BooksyTransfer };
