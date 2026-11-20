import { expect, test } from "bun:test";
import { collectBookingAbsences } from "./absence-evidence";
import { compareBooksySnapshots } from "./delta";
import { transferFixture } from "./fixtures";
import { sourceUuid } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

const base = transferFixture();
function snapshot(refs: string[]): BooksySourceReadModel {
  const appointments: BooksySourceReadModel["appointments"] = refs.map((ref) => ({
    id: sourceUuid(base.businessId, "sourceAppointments", ref),
    clientId: sourceUuid(base.businessId, "clients", "customer"),
    staffId: sourceUuid(base.businessId, "staff", "professional"),
    startsAt: "2026-11-18T09:00:00Z",
    endsAt: "2026-11-18T10:00:00Z",
    createdAt: base.capturedAt,
    updatedAt: base.capturedAt,
    status: "booked",
    notes: null,
    version: 1,
    services: [],
    clientName: "Private contact",
    serviceNames: [],
    sourceCopy: {
      system: "booksy",
      businessId: base.businessId,
      groupRef: ref,
      itemRef: ref,
      capturedAt: base.capturedAt,
      readOnly: true,
    },
  }));
  return {
    version: 1,
    businessId: base.businessId,
    fromDate: "2026-11-18",
    throughDate: "2026-11-30",
    capturedAt: base.capturedAt,
    lastAppointmentProven: false,
    lastObservedAppointmentAt: null,
    businessName: "Fixture centre",
    base: structuredClone(base),
    appointments,
    contexts: Object.fromEntries(
      appointments.map((a) => [
        a.id,
        { customerComment: "Confidential comment", businessMessage: null, rows: [] },
      ]),
    ),
    groups: [],
    inventory: [],
    resources: [],
    summary: {
      bookedServices: appointments.length,
      groups: 0,
      clients: 0,
      services: 0,
      staff: 0,
      blocks: 0,
      directoryClients: 0,
      addons: 0,
      products: 0,
      resources: 0,
    },
  };
}

test("review distinguishes additions, edits and two kinds of absence without disclosing notes", () => {
  const previous = snapshot(["5", "4", "3", "2"]);
  const current = snapshot(["1", "4", "2"]);
  current.capturedAt = Temporal.Instant.from(previous.capturedAt).add({ hours: 1 }).toString();
  previous.appointments[0]!.startsAt = "2026-11-17T22:50:00Z";
  previous.appointments[2]!.startsAt = "2026-11-17T23:10:00Z";
  current.appointments[1]!.staffId = current.appointments[1]!.clientId;
  current.contexts[current.appointments[1]!.id]!.businessMessage = "Confidential business note";
  current.appointments[2]!.startsAt = "2026-11-18T10:00:00+01:00";
  current.appointments[2]!.updatedAt = current.capturedAt;
  current.base.services[0]!.name = "New display name";

  const result = compareBooksySnapshots(previous, current);
  expect(result.bookings).toEqual({
    added: ["1"],
    changed: [{ ref: "4", fields: ["businessMessage", "professional"] }],
    missingFromCurrentWindow: ["3"],
    outsideCurrentWindow: ["5"],
    unchanged: 1,
  });
  expect(result.services.changed).toEqual([
    { ref: current.base.services[0]!.sourceId, fields: ["name"] },
  ]);
  expect(JSON.stringify(result)).not.toContain("Confidential");
  expect(result.canCutOver).toBe(false);
});

test("review rejects duplicate source references and reversed snapshot time", () => {
  const previous = snapshot(["1"]);
  const current = snapshot(["1", "1"]);
  expect(() => compareBooksySnapshots(previous, current)).toThrow("duplicate source reference");
  current.capturedAt = Temporal.Instant.from(previous.capturedAt).subtract({ hours: 1 }).toString();
  expect(() => compareBooksySnapshots(previous, current)).toThrow("chronological snapshots");
});

test("missing lines retain dated evidence and an incomplete calendar cannot establish absence", () => {
  const previous = snapshot(["1"]);
  const current = snapshot([]);
  current.base.staff[0]!.sourceId = "10";
  current.resources = [{ id: 20 }];
  const collector = collectBookingAbsences(previous, current, ["1"], ["2026-11-24", "2026-11-25"]);
  const put = (route: string, hour: number, data: unknown) => {
    collector.inspect(
      {
        kind: "booksy-api-response",
        businessId: current.businessId,
        source: `https://es.booksy.com/core/v2/business_api/me/businesses/${current.businessId}/${route}`,
        capturedAt: `2026-11-17T${hour}:00:00Z`,
        data: { body: JSON.stringify(data), data },
      },
      String(hour),
    );
  };
  const data = (resourceIds: number[], bookings: object) => ({
    start_date: "2026-11-18",
    end_date: "2026-11-24",
    resources_count: resourceIds.length,
    resources: resourceIds.map((id) => ({ id })),
    bookings,
  });
  put("calendar", 10, data([10, 20], { "1": { id: 1 } }));
  put("appointments/1/", 11, { appointment: { appointment_uid: 1, status: "A" } });
  put("calendar", 12, data([10, 20], {}));
  put("calendar", 13, data([10], {}));
  expect(collector.result()).toEqual([
    {
      itemRef: "1",
      groupRef: "1",
      date: "2026-11-18",
      presence: { at: "2026-11-17T10:00:00Z", sha256: "10" },
      absence: { at: "2026-11-17T12:00:00Z", sha256: "12" },
      groupDetail: { at: "2026-11-17T11:00:00Z", sha256: "11", status: "A" },
    },
  ]);
  expect(collector.coverage()).toEqual([
    {
      date: "2026-11-24",
      lastFullObservation: { at: "2026-11-17T12:00:00Z", sha256: "12" },
    },
    { date: "2026-11-25", lastFullObservation: null },
  ]);
});

test("payment evidence delta identifies positive payments, missing evidence and changed groups without exposing values", () => {
  const previous = snapshot([]);
  const current = snapshot([]);
  const group = (sourceId: string, evidence: unknown, note = "") => ({
    sourceId,
    ids: [],
    raw: { appointment: { payment_info: evidence, business_secret_note: note } },
  });
  const noDeposit = {
    deposit_id: null,
    deposit_info: null,
    transaction_id: null,
    transaction_info: null,
  };
  const authorization = {
    ...noDeposit,
    deposit_id: 10,
    deposit_info: {
      id: 10,
      already_paid: "0,00 €",
      total: "8,50 €",
      remaining: "8,50 €",
      status_type: "authorized",
      short_status: "authorized",
      pnref: null,
      payment_rows: [{ status: "authorized", payment_intent: null }],
    },
  };
  const paid = {
    ...authorization,
    deposit_info: { ...authorization.deposit_info, already_paid: "8,50 €", remaining: "0,00 €" },
  };
  const uncertain = { ...noDeposit, transaction_id: "private-transaction-reference" };
  previous.groups = [
    group("10", authorization),
    group("11", paid),
    group("12", paid),
    group("13", noDeposit, "private-before"),
    group("14", uncertain),
  ];
  current.groups = [
    group("10", paid),
    group("11", null),
    group("13", noDeposit, "private-after"),
    group("14", { ...uncertain, transaction_id: "different-private-reference" }),
    group("15", paid),
  ];
  const { payments } = compareBooksySnapshots(previous, current);
  expect(payments).toEqual({
    added: ["15"],
    changed: [
      {
        ref: "10",
        fields: ["deposit"],
        previousState: "authorizedWithoutCharge",
        currentState: "observedPositivePayment",
      },
      {
        ref: "11",
        fields: ["deposit", "paymentDetail"],
        previousState: "observedPositivePayment",
        currentState: "withoutPaymentDetail",
      },
      {
        ref: "14",
        fields: ["transaction"],
        previousState: "needsReconciliation",
        currentState: "needsReconciliation",
      },
    ],
    absentFromCurrentSnapshot: ["12"],
    unchanged: 1,
    withoutPaymentDetail: ["11"],
    observedPositivePayment: ["10", "15"],
    needsReconciliation: ["14"],
  });
  expect(JSON.stringify(payments)).not.toMatch(/8,50|private/);
});
