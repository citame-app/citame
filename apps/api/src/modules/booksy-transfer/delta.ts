import { readBooksyPaymentEvidence } from "./payment-evidence";
import { stableJson } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";
import type { BooksyWaitlistProjection } from "./waitlist";

type Snapshot = BooksySourceReadModel;
type Booking = Snapshot["appointments"][number];

function index<T>(rows: readonly T[], reference: (row: T) => string) {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = reference(row);
    if (!key || result.has(key)) throw new Error("Missing or duplicate source reference");
    result.set(key, row);
  }
  return result;
}

function compare<T>(
  previous: Map<string, T>,
  current: Map<string, T>,
  changes: (before: T, after: T) => string[],
) {
  const added: string[] = [];
  const changed: { ref: string; fields: string[] }[] = [];
  const absent: string[] = [];
  let unchanged = 0;
  for (const ref of [...current.keys()].sort()) {
    const before = previous.get(ref);
    if (!before) {
      added.push(ref);
      continue;
    }
    const fields = changes(before, current.get(ref)!);
    if (fields.length) changed.push({ ref, fields });
    else unchanged++;
  }
  for (const ref of [...previous.keys()].sort()) {
    if (!current.has(ref)) absent.push(ref);
  }
  return { added, changed, absent, unchanged };
}

function changedFields(previous: Record<string, unknown>, current: Record<string, unknown>) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .sort()
    .filter((key) => stableJson(previous[key]) !== stableJson(current[key]));
}

function fields(snapshot: Snapshot, booking: Booking) {
  const context = snapshot.contexts[booking.id];
  if (!context) throw new Error("Missing booked service context");
  return {
    reservation: booking.sourceCopy?.groupRef,
    client: booking.clientId,
    professional: booking.staffId,
    start: Temporal.Instant.from(booking.startsAt).toString(),
    end: Temporal.Instant.from(booking.endsAt).toString(),
    status: booking.status,
    services: booking.services,
    resources: booking.resources,
    preferences: context.rows.map((row) => [row.servicePosition, row.requestedStaffId]),
    billing: context.rows.map((row) => [row.servicePosition, row.paid, row.invoiced]),
    clientComment: [context.customerComment, context.rows.map((row) => row.customerComment)],
    internalNotes: context.rows.map((row) => row.internalNote),
    businessMessage: context.businessMessage,
  };
}

function bookings(snapshot: Snapshot) {
  return index(snapshot.appointments, (booking) => {
    if (booking.sourceCopy?.businessId !== snapshot.businessId)
      throw new Error("Booked service belongs to another source");
    return booking.sourceCopy.itemRef;
  });
}

const sourceId = (row: { sourceId: string }) => row.sourceId;
const rawId = (row: Record<string, unknown>) =>
  typeof row.id === "number" && Number.isSafeInteger(row.id) ? String(row.id) : "";

export function compareBooksyWaitlists(
  previous: BooksyWaitlistProjection,
  current: BooksyWaitlistProjection,
) {
  const terms = (row: BooksyWaitlistProjection["entries"][number]) => ({
    client: row.clientId,
    date: row.requestedDate,
    durationMinutes: row.durationMinutes,
    flexible: row.flexible,
    priority: row.sourceOrder,
  });
  const before = index(previous.entries, (row) => row.id);
  const after = index(current.entries, (row) => row.id);
  const { absent, ...changes } = compare(before, after, (a, b) =>
    changedFields(terms(a), terms(b)),
  );
  const absentOnReobservedDate: string[] = [];
  const absenceUnverified: string[] = [];
  for (const ref of absent) {
    const date = before.get(ref)!.requestedDate;
    const oldCapture = previous.observedAtByDate.get(date);
    const newCapture = current.observedAtByDate.get(date);
    if (!oldCapture) throw new Error("Missing waitlist observation");
    (newCapture && Temporal.Instant.compare(newCapture, oldCapture) > 0
      ? absentOnReobservedDate
      : absenceUnverified
    ).push(ref);
  }
  return {
    ...changes,
    absentOnReobservedDate,
    absenceUnverified,
    previousObservedDates: previous.observedDates,
    currentObservedDates: current.observedDates,
    datesWithoutNewObservation: [...previous.observedAtByDate]
      .filter(([date, at]) => {
        const next = current.observedAtByDate.get(date);
        return !next || Temporal.Instant.compare(next, at) <= 0;
      })
      .map(([date]) => date)
      .sort(),
  };
}

function comparePayments(previous: Snapshot["groups"], current: Snapshot["groups"]) {
  const evidenceByGroup = (groups: Snapshot["groups"]) =>
    index(
      groups.map((group) => {
        const { detail, state } = readBooksyPaymentEvidence(group.raw);
        const payment =
          detail && typeof detail === "object" && !Array.isArray(detail)
            ? (detail as Record<string, unknown>)
            : null;
        const {
          deposit_id,
          deposit_info,
          transaction_id,
          transaction_info,
          ...otherPaymentFields
        } = payment ?? {};
        const financialHold =
          group.raw && typeof group.raw === "object" && "financialHold" in group.raw
            ? group.raw.financialHold
            : null;
        return {
          sourceId: group.sourceId,
          state,
          fields: {
            deposit: [deposit_id ?? null, deposit_info ?? null],
            transaction: [transaction_id ?? null, transaction_info ?? null],
            paymentDetail: payment === null ? detail : otherPaymentFields,
            financialHold,
          },
        };
      }),
      sourceId,
    );
  const before = evidenceByGroup(previous);
  const after = evidenceByGroup(current);
  const changes = compare(before, after, (left, right) => changedFields(left.fields, right.fields));
  const referencesWith = (state: ReturnType<typeof readBooksyPaymentEvidence>["state"]) =>
    [...after]
      .filter(([, entry]) => entry.state === state)
      .map(([ref]) => ref)
      .sort();
  return {
    added: changes.added,
    changed: changes.changed.map(({ ref, fields }) => {
      const old = before.get(ref);
      const current = after.get(ref);
      if (!old || !current) throw new Error("Payment evidence is missing for a changed group");
      return { ref, fields, previousState: old.state, currentState: current.state };
    }),
    absentFromCurrentSnapshot: changes.absent,
    unchanged: changes.unchanged,
    withoutPaymentDetail: referencesWith("withoutPaymentDetail"),
    observedPositivePayment: referencesWith("observedPositivePayment"),
    needsReconciliation: referencesWith("needsReconciliation"),
  };
}

/** The receipt contains origin references, never values from notes, profiles or payments. */
export function compareBooksySnapshots(previous: Snapshot, current: Snapshot) {
  if (
    previous.version !== 1 ||
    current.version !== 1 ||
    previous.businessId !== current.businessId ||
    previous.base.timezone !== current.base.timezone ||
    Temporal.Instant.compare(previous.capturedAt, current.capturedAt) > 0
  )
    throw new Error("Expected chronological snapshots from the same business and timezone");

  const before = bookings(previous);
  const after = bookings(current);
  // Validate context even for newly observed and absent services.
  const beforeFields = new Map([...before].map(([ref, row]) => [ref, fields(previous, row)]));
  const afterFields = new Map([...after].map(([ref, row]) => [ref, fields(current, row)]));
  const changes = compare(beforeFields, afterFields, changedFields);
  const missingFromCurrentWindow: string[] = [];
  const outsideCurrentWindow: string[] = [];
  for (const ref of changes.absent) {
    const day = Temporal.Instant.from(before.get(ref)!.startsAt)
      .toZonedDateTimeISO(current.base.timezone)
      .toPlainDate()
      .toString();
    (day < current.fromDate || day > current.throughDate
      ? outsideCurrentWindow
      : missingFromCurrentWindow
    ).push(ref);
  }

  const other = <T extends Record<string, unknown>>(
    a: readonly T[],
    b: readonly T[],
    id: (row: T) => string,
  ) => compare(index(a, id), index(b, id), changedFields);
  return {
    bookings: {
      added: changes.added,
      changed: changes.changed,
      missingFromCurrentWindow,
      outsideCurrentWindow,
      unchanged: changes.unchanged,
    },
    groups: other(previous.groups, current.groups, sourceId),
    payments: comparePayments(previous.groups, current.groups),
    staff: other(previous.base.staff, current.base.staff, sourceId),
    services: other(previous.base.services, current.base.services, sourceId),
    clients: other(previous.base.clients, current.base.clients, sourceId),
    hours: other(previous.base.hours, current.base.hours, sourceId),
    blocks: other(previous.base.timeOff, current.base.timeOff, sourceId),
    assignments: other(previous.base.assignments, current.base.assignments, (row) =>
      JSON.stringify([row.staffRef, row.serviceRef]),
    ),
    inventory: other(previous.inventory, current.inventory, rawId),
    resources: other(previous.resources, current.resources, rawId),
    canCutOver: false,
  };
}
