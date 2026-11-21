import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarAppointmentSchema, calendarResponseSchema } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  retailProduct,
  salonSettings,
  staffReservation,
  stockMovement,
} from "@sob/db";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createTestValkey } from "../../../test/valkey";
import { createApp } from "../../app";
import { createAccount } from "../../auth/accounts";
import { createAuth } from "../../auth/auth";
import type { AppEnv, Principal } from "../../auth/principal";
import { loadConfig } from "../../config";
import { DomainError } from "../../errors";
import { respondError } from "../../http";
import { reconcileObservedCalendar } from "../../scripts/booksy-reconcile-calendar";
import { appendVisibleStaffBlock } from "../../scripts/booksy-review-visible-block";
import { appendVisibleBooking } from "../../scripts/booksy-review-visible-booking";
import { transferFixture } from "./fixtures";
import {
  countCapacityConflicts,
  inspectNativeBooksy,
  planNativeRehearsal,
  summarizeNativeSchedule,
} from "./operational-rehearsal";
import { fingerprint, planBooksyTransfer, sourceUuid } from "./plan";
import { applyBooksyRehearsal } from "./rehearsal";
import { verifyBookedBooksyCombinations } from "./source-combinations";
import { type BooksySourceReadModel, booksyCents, sourceInstant } from "./source-read-model";
import { booksySourceRoutes } from "./source-routes";
import {
  loadBooksySourceModel,
  storeBooksySourceModel,
  verifyBooksySourceModel,
} from "./source-store";
import { stageBooksyArchive } from "./stage";

let t: TestDatabase;
function fixture(): BooksySourceReadModel {
  const base = transferFixture();
  base.appointments = [];
  base.horizon.lastAppointmentAt = null;
  const id = (kind: string, key: string) => sourceUuid(base.businessId, kind, key);
  const appointments = ["1", "2"].map((key) =>
    calendarAppointmentSchema.parse({
      id: id("sourceAppointments", key),
      staffId: id("staff", "staff-1"),
      clientId: id("clients", "client-1"),
      startsAt: "2026-11-18T09:00:00Z",
      endsAt: "2026-11-18T10:00:00Z",
      status: "booked",
      notes: null,
      version: 1,
      services: [
        {
          serviceId: id("services", "service-1"),
          name: "Synthetic service",
          durationMinutes: 60,
          bufferMinutes: 0,
          priceCents: 5000,
          currency: "EUR",
        },
      ],
      createdAt: base.capturedAt,
      updatedAt: base.capturedAt,
      clientName: "Synthetic client",
      serviceNames: ["Synthetic service"],
      serviceBadges: [
        {
          servicePosition: 0,
          requested: true,
          invoiced: false,
          paid: true,
          billingSource: "booksy",
          internalNote: true,
          customerComment: true,
        },
      ],
      sourceCopy: {
        system: "booksy",
        businessId: base.businessId,
        groupRef: key,
        itemRef: key,
        capturedAt: base.capturedAt,
        readOnly: true,
      },
    }),
  );
  const contexts = Object.fromEntries(
    appointments.map((a) => [
      a.id,
      {
        customerComment: "CLIENT COMMENT",
        businessMessage: "BUSINESS MESSAGE",
        rows: [
          {
            servicePosition: 0,
            requestedStaffId: a.staffId,
            internalNote: "PRIVATE\u0000 note",
            customerComment: null,
            invoiced: null,
            paid: true,
            version: 1,
            source: "booksy" as const,
            sourceRef: a.id,
          },
        ],
      },
    ]),
  );
  return {
    version: 1,
    businessId: base.businessId,
    fromDate: base.fromDate,
    throughDate: "2026-11-24",
    capturedAt: base.capturedAt,
    lastAppointmentProven: false,
    lastObservedAppointmentAt: appointments[0]!.startsAt,
    base,
    appointments,
    contexts,
    groups: appointments.map((a) => ({
      sourceId: a.sourceCopy!.groupRef,
      ids: [a.id],
      raw: { sort: "a\u0000b" },
    })),
    inventory: [
      {
        id: 44,
        name: "Synthetic product",
        archived: false,
        gross_price: "12.50",
        full_packages_left: 5,
        total_pack_capacity: 12.5,
        volume_unit: { symbol: "ml" },
        product_type: "r",
        category_name: null,
        brand_name: null,
        barcodes: [],
        tax_rate_value: null,
        stock_levels: [{ minimum_packages: null, maximum_packages: null }],
      },
    ],
    resources: [{ id: 77, name: "Synthetic station", type: "R" }],
    businessName: "Synthetic business",
    summary: {
      groups: 2,
      bookedServices: 2,
      clients: 1,
      services: 1,
      staff: 1,
      blocks: 0,
      directoryClients: 1,
      addons: 0,
      products: 1,
      resources: 1,
    },
  };
}
const model = fixture();

test("reviewed visible bookings keep their exact resource and reject conflicting contact identity", () => {
  const snapshot = fixture();
  snapshot.base.staff[0]!.sourceId = "11";
  snapshot.base.clients[0]!.sourceId = "12";
  snapshot.base.clients[0]!.name = "Synthetic client";
  snapshot.base.clients[0]!.phone = "+34600123456";
  snapshot.base.services[0]!.name = "Synthetic service";
  snapshot.base.services[0]!.raw = { resources: [77] };
  snapshot.base.assignments[0]!.staffRef = "11";
  for (const group of snapshot.groups) {
    group.raw = {
      appointment: { subbookings: [{ id: Number(group.sourceId), appliance_id: null }] },
    };
  }
  const common = {
    capturedAt: "2026-11-18T08:00:00Z",
    date: "2026-11-18",
    timezone: "Europe/Madrid",
  };
  const detail = (source: string, text: string) => ({
    ...common,
    source,
    ref: "a-14",
    text,
    textSha256: createHash("sha256").update(text).digest("hex"),
  });
  const documents = [
    {
      ...detail("booksy_visible_calendar_card", "13:20 - 13:30\nSynthetic service"),
      appointmentRef: "14",
      itemElementId: "cc-15",
      columnResource: "11",
    },
    {
      ...detail(
        "booksy_visible_drawer",
        "CONFIRMADO\nSynthetic client\n600 123 456\nRESERVA DE GRUPO\nmiércoles\nSynthetic service\n10min\n15,00 €\nExtras\nInicio\nAsignado por sistema\nTasa de cancelación",
      ),
      calendarRange: { start: "13:20", end: "13:30" },
    },
    {
      ...common,
      source: "booksy_visible_appointment_assignment",
      ref: "a-14",
      fields: [
        { label: "Inicio", value: "13:20" },
        { label: "Fin", value: "13:30" },
        { label: "Empleado", value: snapshot.base.staff[0]!.name },
        { label: "Recurso", value: "Synthetic station" },
      ],
    },
    {
      ...common,
      source: "booksy_visible_customer_profile",
      bookingRef: "a-14",
      customerRef: "12",
      name: "Synthetic client",
      phone: "600 123 456",
      matchedNameAndPhone: true,
    },
    {
      ...detail("booksy_visible_notes", "Nota interna\nMensaje para el cliente"),
      fields: [
        { placeholder: "Nota interna", value: "" },
        { placeholder: "Mensaje para el cliente", value: "" },
      ],
    },
  ];
  const evidence = { path: "synthetic-verified.json", bytes: 24, sha256: "a".repeat(64) };
  const result = appendVisibleBooking(snapshot, documents, evidence);
  const visit = planNativeRehearsal(result).visits.find(
    (row) => row.item.sourceCopy?.itemRef === "15",
  );
  expect(visit?.resource?.name).toBe("Synthetic station");
  expect(visit?.context.rows[0]?.paid).toBeNull();
  expect(visit?.services[0]?.priceCents).toBe(1500);
  expect(snapshot.appointments).toHaveLength(2);
  expect(() => appendVisibleBooking(result, documents, evidence)).toThrow("already archived");
  const discounted = [...documents];
  discounted[1] = {
    ...detail(
      "booksy_visible_drawer",
      "CONFIRMADO\nSynthetic client\n600 123 456\nRESERVA DE GRUPO\nmiércoles\nSynthetic service\n10min\n0,00 €\nExtras\nInicio\nEmpleado elegido manualmente\nDescuento\n-15,00 €\nTotal\n0,00 €\nA pagar\n0,00 €",
    ),
    calendarRange: { start: "13:20", end: "13:30" },
  };
  expect(() => appendVisibleBooking(snapshot, discounted, evidence)).toThrow("fresh review");
  const amountHeld = appendVisibleBooking(snapshot, discounted, evidence, false, true);
  const amountVisit = planNativeRehearsal(amountHeld).visits.find(
    (row) => row.item.sourceCopy?.itemRef === "15",
  );
  expect(amountVisit?.services[0]).toMatchObject({ priceCents: 0, sourceUnpriced: true });
  expect(amountVisit?.context.rows[0]).toMatchObject({ paid: null, invoiced: null });
  expect(amountHeld.base.unprojected.at(-1)).toMatchObject({
    kind: "booksy_visible_discount_requires_review",
    raw: { discount: "-15,00 €", displayedDue: "0,00 €" },
  });
  snapshot.base.clients[0]!.name = "A different person";
  snapshot.base.clients[0]!.phone = null;
  expect(() => appendVisibleBooking(snapshot, documents, evidence)).toThrow(
    "does not match the archived contact",
  );
  expect(snapshot.appointments).toHaveLength(2);
  const held = appendVisibleBooking(snapshot, documents, evidence, true);
  const contact = held.base.clients.at(-1)!;
  expect(contact).toMatchObject({ bookingAccess: "blocked", phone: null, email: null });
  expect(held.base.clients[0]).toEqual(snapshot.base.clients[0]);
  const pending = planNativeRehearsal(held).visits.find(
    (visit) => visit.item.sourceCopy?.itemRef === "15",
  )!;
  expect(pending.item.clientId).toBe(sourceUuid(snapshot.businessId, "clients", contact.sourceId));
  expect(pending.resource?.name).toBe("Synthetic station");
});

test("calendar card reconciliation requires stable line, reservation, professional and hours", () => {
  const snapshot = fixture();
  snapshot.base.staff[0]!.sourceId = "11";
  for (const appointment of snapshot.appointments) {
    appointment.staffId = sourceUuid(snapshot.businessId, "staff", "11");
  }
  const card = {
    itemElementId: "cc-1",
    appointmentAttribute: "1",
    columnResource: "11",
    interval: "10:00 - 11:00",
  };
  const observation = {
    capturedAt: "2026-11-18T08:00:00Z",
    source: "booksy_visible_calendar",
    date: "2026-11-18",
    timezone: "Europe/Madrid",
    filter: "working",
    cards: [card, { ...card, itemElementId: "cc-3" }],
  };
  const result = reconcileObservedCalendar(snapshot, observation);
  expect(result.matches).toBe(1);
  expect(result.observedOnly[0]?.itemRef).toBe("3");
  expect(result.archivedNotVisible).toEqual(["2"]);
  expect(result.canCutOver).toBe(false);
  const change = reconcileObservedCalendar(snapshot, {
    ...observation,
    cards: [
      { ...card, appointmentAttribute: "24", columnResource: "12", interval: "10:05 - 11:05" },
    ],
  });
  expect(change.differences).toEqual([
    { itemRef: "1", fields: ["reservation", "professional", "start", "end"] },
  ]);
  expect(() =>
    reconcileObservedCalendar(snapshot, { ...observation, cards: [card, card] }),
  ).toThrow("duplicate");
  const all = { ...observation, filter: "all", staffResources: ["11"], cards: [card] };
  const { interval: _interval, ...identity } = card;
  snapshot.base.timeOff = [
    {
      sourceId: "block-1",
      staffRef: "11",
      startsAt: "2026-11-18T12:00:00Z",
      endsAt: "2026-11-18T12:30:00Z",
      reason: null,
      raw: {},
    },
  ];
  expect(
    reconcileObservedCalendar(snapshot, {
      ...all,
      cardsWithoutVisibleTimes: [{ ...identity, itemElementId: "cc-2" }],
      staffBlocks: [{ ...card, itemElementId: "cc-4", interval: "13:00 - 13:30" }],
    }),
  ).toMatchObject({
    staffColumnsObserved: 1,
    archivedNotVisible: [],
    cardsWithoutVisibleTimes: [{ itemRef: "2", archived: true }],
    staffBlocks: { matches: 1, observedOnly: [], archivedNotVisible: [] },
  });
  expect(() => reconcileObservedCalendar(snapshot, { ...all, staffResources: ["12"] })).toThrow(
    "visible columns",
  );
  expect(() => reconcileObservedCalendar(snapshot, { ...all, cards: [] })).toThrow(
    "empty calendar observation",
  );
  expect(reconcileObservedCalendar(snapshot, { ...all, cards: [], staffBlocks: [] })).toMatchObject(
    {
      matches: 0,
      archivedNotVisible: ["1", "2"],
      canCutOver: false,
    },
  );
});

test("a supplemental block requires the same date, full team, and verified staff-only interval", () => {
  const snapshot = fixture();
  const staff = snapshot.base.staff[0]!;
  staff.sourceId = "11";
  const date = "2026-11-18";
  const card = {
    itemElementId: "cc-9",
    appointmentAttribute: "9",
    columnResource: staff.sourceId,
    interval: "13:00 - 13:30",
  };
  const observation = {
    source: "booksy_visible_calendar",
    date,
    capturedAt: "2026-11-18T10:00:00Z",
    filter: "all",
    timezone: "Europe/Madrid",
    staffResources: snapshot.base.staff.map((row) => row.sourceId),
    staffBlocks: [card],
  };
  const details = {
    date,
    source: "booksy_visible_difference_details",
    observed: { block: card },
    staffBlock: {
      drawer: "FALTA DE DISPONIBILIDAD",
      fields: Object.entries({
        Fecha: "mié., 18 nov.",
        Inicio: "13:00",
        Fin: "13:30",
        Empleado: staff.name,
        Recurso: "Ningún recurso",
        Motivo: "Fixture",
      }).map(([placeholder, value]) => ({ placeholder, value })),
    },
  };
  const evidence = { path: "supplement.json", sha256: "5".repeat(64), bytes: 1 };
  const amended = appendVisibleStaffBlock(snapshot, observation, details, evidence);
  expect(amended.base.timeOff.at(-1)).toMatchObject({
    sourceId: "9",
    staffRef: staff.sourceId,
    startsAt: "2026-11-18T12:00:00Z",
    endsAt: "2026-11-18T12:30:00Z",
  });
  expect(amended.appointments).toEqual(snapshot.appointments);
  expect(() => appendVisibleStaffBlock(amended, observation, details, evidence)).toThrow(
    "already archived",
  );
  details.staffBlock.fields[4]!.value = "Fixture resource";
  expect(() => appendVisibleStaffBlock(snapshot, observation, details, evidence)).toThrow(
    "staff interval",
  );
});

test("capacity review counts separate overload periods and honors adjacent bookings", () => {
  const intervals = [
    { start: 0, end: 10 },
    { start: 3, end: 6 },
    { start: 6, end: 7 },
    { start: 9, end: 12 },
    { start: 12, end: 17 },
  ];
  expect(countCapacityConflicts(intervals, 1)).toBe(2);
  expect(countCapacityConflicts(intervals, 2)).toBe(0);
});

test("native rehearsal keeps imported resource and professional overlaps explicit", () => {
  const source = structuredClone(model);
  source.groups.forEach((group, i) => {
    const item = source.appointments[i]!;
    group.raw = {
      appointment: {
        subbookings: [{ id: Number(item.sourceCopy!.itemRef), appliance_id: 1 }],
      },
    };
    item.resources = [{ name: "Synthetic resource", quantity: 1 }];
  });
  source.resources = [{ id: 1, name: "Synthetic resource" }];
  const projected = planNativeRehearsal(source);
  expect(projected.visits).toHaveLength(2);
  expect([...projected.staff.values()][0]?.units).toBe(2);
  expect([...projected.resources.values()][0]?.units).toBe(2);
  expect(source.base.appointments).toHaveLength(0);
  source.appointments[0]!.resources![0]!.name = "Missing source resource";
  expect(() => planNativeRehearsal(source)).toThrow("resource assignment differ");
});

test("native rehearsal preserves shared visit identity across professional columns", () => {
  const source = fixture();
  const [first, second] = source.appointments;
  if (!first?.sourceCopy || !second?.sourceCopy) throw new Error("Missing source fixture");
  const sourceId = first.sourceCopy.groupRef;
  second.sourceCopy.groupRef = sourceId;
  second.staffId = sourceUuid(source.businessId, "staff", "another-professional");
  source.groups = [
    {
      sourceId,
      ids: [first.id, second.id],
      raw: {
        appointment: {
          subbookings: [first, second].map((item) => ({
            id: Number(item.sourceCopy!.itemRef),
            appliance_id: null,
          })),
        },
      },
    },
  ];
  source.summary.groups = 1;
  const plan = planNativeRehearsal(source);
  expect(plan.staff.size).toBe(2);
  expect(plan.visits.map((visit) => visit.visitGroupId)).toEqual(
    Array(2).fill(sourceUuid(source.businessId, "visitGroups", sourceId)),
  );
  source.groups.push(structuredClone(source.groups[0]!));
  expect(() => planNativeRehearsal(source)).toThrow("empty or duplicated");
});

test("candidate schedule groups by local start date, professional and status", () => {
  const [first] = fixture().appointments;
  if (!first) throw new Error("Missing booking fixture");
  const beforeMidnight = {
    start: Date.parse("2027-03-28T21:50:00Z"),
    visitGroupId: "shared-reservation",
    services: first.services,
    item: { staffId: "a", status: "booked" as const },
  };
  const afterMidnight = { ...beforeMidnight, start: Date.parse("2027-03-28T22:30:00Z") };
  const anotherProfessional = { ...beforeMidnight, item: { ...beforeMidnight.item, staffId: "b" } };
  const cancelled = { ...beforeMidnight, item: { staffId: "a", status: "cancelled" as const } };
  const anotherReservation = {
    ...beforeMidnight,
    visitGroupId: "another-reservation",
    services: [...beforeMidnight.services, ...beforeMidnight.services],
  };

  expect(
    summarizeNativeSchedule(
      [
        afterMidnight,
        anotherProfessional,
        beforeMidnight,
        cancelled,
        anotherReservation,
        beforeMidnight,
      ],
      "Europe/Madrid",
    ),
  ).toEqual([
    {
      date: "2027-03-28",
      staffId: "a",
      status: "booked",
      calendarLines: 3,
      visitGroups: 2,
      frozenServices: 4,
    },
    {
      date: "2027-03-28",
      staffId: "a",
      status: "cancelled",
      calendarLines: 1,
      visitGroups: 1,
      frozenServices: 1,
    },
    {
      date: "2027-03-28",
      staffId: "b",
      status: "booked",
      calendarLines: 1,
      visitGroups: 1,
      frozenServices: 1,
    },
    {
      date: "2027-03-29",
      staffId: "a",
      status: "booked",
      calendarLines: 1,
      visitGroups: 1,
      frozenServices: 1,
    },
  ]);
});

test("native rehearsal refuses a frozen treatment, professional, interval, price or preference that differs from the archived detail", () => {
  const source = fixture();
  const item = source.appointments[0]!;
  source.appointments = [item];
  source.groups = [source.groups[0]!];
  source.summary.bookedServices = 1;
  source.summary.groups = 1;
  item.staffId = sourceUuid(source.businessId, "staff", "11");
  item.services[0]!.serviceId = sourceUuid(source.businessId, "services", "22");
  source.contexts[item.id]!.rows[0]!.requestedStaffId = item.staffId;
  const group = source.groups[0]!;
  const leaf = {
    id: Number(item.sourceCopy!.itemRef),
    booked_from: "2026-11-18T10:00:00",
    booked_till: "2026-11-18T11:00:00",
    staffer_id: 11,
    service: { id: 22, name: "Synthetic service" },
    service_price: "50,00 €",
    is_staffer_requested_by_client: true,
    appliance_id: null,
    addons: [],
  };
  const assign = (detail: Record<string, unknown> = leaf, groupId = Number(group.sourceId)) => {
    group.raw = { appointment: { appointment_uid: groupId, subbookings: [detail] } };
  };
  assign();
  expect(planNativeRehearsal(source).visits).toHaveLength(1);
  for (const [change, message] of [
    [{ booked_till: "2026-11-18T11:05:00" }, "interval differs"],
    [{ staffer_id: 12 }, "professional differs"],
    [{ service: { ...leaf.service, id: 23 } }, "treatment differs"],
    [{ service: { ...leaf.service, name: "Different treatment" } }, "treatment differs"],
    [{ service_price: "No mostrar" }, "price differs"],
    [{ service_price: "49,95 €" }, "price differs"],
    [{ is_staffer_requested_by_client: false }, "preference differs"],
    [{ booked_from: undefined }, "missing linked booking evidence"],
  ] as const) {
    assign({ ...leaf, ...change });
    expect(() => planNativeRehearsal(source)).toThrow(message);
  }
  assign(leaf, Number(group.sourceId) + 1);
  expect(() => planNativeRehearsal(source)).toThrow("identifier differs");
  assign();
  source.contexts[item.id]!.rows[0]!.requestedStaffId = null;
  expect(() => planNativeRehearsal(source)).toThrow("preference context differs");
});

test("native rehearsal verifies ordered booked extras, including quantities and missing catalogue links", () => {
  const source = fixture();
  const item = source.appointments[0]!;
  source.appointments = [item];
  source.groups = [source.groups[0]!];
  source.summary.bookedServices = 1;
  source.summary.groups = 1;
  const archived = { id: 31, name: "Archived extra", price: "3,50 €", duration: 5, quantity: 2 };
  const current = { id: 32, name: "Current extra", price: 2.5, duration: 5, quantity: 1 };
  source.base.services.push({ ...source.base.services[0]!, sourceId: "addon:32" });
  item.services.push(
    {
      serviceId: null,
      name: "Archived extra × 2",
      durationMinutes: 10,
      bufferMinutes: 0,
      priceCents: 700,
      currency: "EUR",
    },
    {
      serviceId: sourceUuid(source.businessId, "services", "addon:32"),
      name: "Current extra",
      durationMinutes: 5,
      bufferMinutes: 0,
      priceCents: 250,
      currency: "EUR",
    },
  );
  const context = source.contexts[item.id]!;
  const primary = context.rows[0]!;
  context.rows.push({ ...primary, servicePosition: 1 }, { ...primary, servicePosition: 2 });
  const group = source.groups[0]!;
  const assign = (addons: unknown) => {
    group.raw = {
      appointment: {
        subbookings: [{ id: Number(item.sourceCopy!.itemRef), appliance_id: null, addons }],
      },
    };
  };
  assign([archived, current]);
  expect(planNativeRehearsal(source).visits[0]!.services).toMatchObject([
    { durationMinutes: 45 },
    { serviceId: null, name: "Archived extra × 2", durationMinutes: 10, priceCents: 700 },
    { name: "Current extra", durationMinutes: 5, priceCents: 250 },
  ]);
  for (const addons of [
    undefined,
    [archived],
    [current, archived],
    [{ ...archived, quantity: 1 }, current],
    [{ ...archived, duration: 6 }, current],
    [{ ...archived, price: 3 }, current],
    [archived, { ...current, id: 33 }],
  ]) {
    assign(addons);
    expect(() => planNativeRehearsal(source)).toThrow("booked add-ons differ");
  }
});

test("native rehearsal rejects missing, repeated and unverified service lines from reservation details", () => {
  const source = fixture();
  for (const [index, group] of source.groups.entries()) {
    group.raw = {
      appointment: {
        subbookings: [
          {
            id: Number(source.appointments[index]!.sourceCopy!.itemRef),
            appliance_id: null,
          },
        ],
      },
    };
  }
  const group = source.groups[0]!;
  const booking = { id: Number(source.appointments[0]!.sourceCopy!.itemRef), appliance_id: null };
  const missing = { id: 802, appliance_id: null };
  const setExtra = (extra: object) => {
    group.raw = {
      appointment: { subbookings: [booking, extra] },
    };
  };
  for (const extra of [
    missing,
    { ...missing, booked_from: "2026-11-18T10:00:00", booked_till: "2026-11-18T11:00:00" },
    { ...missing, booked_from: "2026-11-17T23:30:00", booked_till: "2026-11-18T00:30:00" },
    { ...missing, booked_from: "2026-11-15T10:00:00", booked_till: "2026-11-15T09:00:00" },
  ]) {
    setExtra(extra);
    expect(() => planNativeRehearsal(source)).toThrow("missing from the captured calendar");
  }
  setExtra(booking);
  expect(() => planNativeRehearsal(source)).toThrow("repeats a service line");
  setExtra({
    ...missing,
    booked_from: "2026-11-25T00:00:00",
    booked_till: "2026-11-25T01:00:00",
  });
  expect(planNativeRehearsal(source).visits).toHaveLength(2);
});

test("booked combination prices reconcile without creating a second sellable line for the wrapper", () => {
  const source = fixture();
  const [first, second] = source.appointments;
  if (!first || !second) throw new Error("Expected two projected components");
  const root = {
    id: 3,
    service_price: "100.00",
    combo_children: [
      { id: 1, service_price: "50.00" },
      { id: 2, service_price: "50.00" },
    ],
  };
  source.groups = [
    {
      sourceId: "combined",
      ids: [first.id, second.id],
      raw: { appointment: { subbookings: [root] } },
    },
  ];
  expect(verifyBookedBooksyCombinations(source)).toEqual({
    combinations: 1,
    frozenComponents: 2,
    componentsOutsideProjection: 0,
    paidComponents: 2,
    invoicedComponents: 0,
    componentsWithoutInvoiceEvidence: 2,
  });
  root.service_price = "99.00";
  expect(() => verifyBookedBooksyCombinations(source)).toThrow("prices differ from its total");
  root.service_price = "100.00";
  first.services[0]!.priceCents = 4500;
  expect(() => verifyBookedBooksyCombinations(source)).toThrow("Frozen price differs");
});
beforeAll(async () => {
  t = await createTestDatabase("booksy_transfer_source_model");
});
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`do $$ begin
      if to_regclass('booksy_rehearsal.source_snapshot') is not null then
        truncate booksy_rehearsal.source_entity,booksy_rehearsal.source_appointment,booksy_rehearsal.source_snapshot;
      end if;
      if to_regclass('booksy_rehearsal.run') is not null then
        truncate booksy_rehearsal.entity,booksy_rehearsal.run;
      end if;
    end $$`,
  );
  await applyBooksyRehearsal(t.db, model.base, planBooksyTransfer(model.base).review.reviewHash);
  await storeBooksySourceModel(t.db, model);
  await t.db.insert(salonSettings).values({ name: "Synthetic", timezone: "Europe/Madrid" });
});
afterAll(async () => {
  await t.close();
});
test("retains overlapping source appointments, groups and private NUL notes idempotently without changing scheduling capacity", async () => {
  const first = await storeBooksySourceModel(t.db, model);
  await storeBooksySourceModel(t.db, model);
  expect(first.sourceAppointmentsVerified).toBe(true);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const loaded = await loadBooksySourceModel(t.db, first.hash);
  expect(loaded).toEqual(model);
  const [product] = await t.db.select().from(retailProduct);
  expect(product).toMatchObject({
    stockOnHand: 5,
    active: false,
    costCents: null,
    packageContentQuantity: "12.5",
    packageContentUnit: "ml",
  });
  await t.db.execute(
    sql`update booksy_rehearsal.source_appointment set context='{}'::jsonb where id=${model.appointments[0]!.id}::uuid`,
  );
  await expect(verifyBooksySourceModel(t.db, model)).rejects.toThrow("private annotations differ");
});

test("retains old product fingerprints through migration and detects changed package content", async () => {
  const [product] = await t.db.select().from(retailProduct);
  if (!product) throw new Error("Expected the imported fixture product");
  const {
    packageContentQuantity: _,
    packageContentUnit: __,
    stockAllocated: ___,
    ...legacy
  } = product;
  await t.db
    .update(retailProduct)
    .set({
      packageContentQuantity: null,
      packageContentUnit: null,
      updatedAt: product.updatedAt,
    })
    .where(eq(retailProduct.id, product.id));
  await t.db.execute(
    sql`update booksy_rehearsal.source_entity set target_hash=${fingerprint(legacy)} where kind='sourceProducts'`,
  );
  expect((await verifyBooksySourceModel(t.db, model)).sourceAppointmentsVerified).toBe(true);
  await expect(
    t.db.transaction(async (tx) => {
      await tx.execute(sql`alter table retail_product drop column package_content_quantity,
        drop column package_content_unit`);
      expect((await verifyBooksySourceModel(tx, model)).sourceAppointmentsVerified).toBe(true);
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
  await t.db
    .update(retailProduct)
    .set({ packageContentQuantity: "10", packageContentUnit: "ml" })
    .where(eq(retailProduct.id, product.id));
  await expect(verifyBooksySourceModel(t.db, model)).rejects.toThrow(
    "Native product/resource fields changed",
  );
});

test("old product fingerprints verify before and after classification backfill", async () => {
  const [product] = await t.db.select().from(retailProduct);
  if (!product) throw new Error("Expected the imported fixture product");
  const migration = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0099_inventory_classification.sql",
      import.meta.url,
    ),
  ).text();
  await expect(
    t.db.transaction(async (tx) => {
      const [labelled] = await tx
        .update(retailProduct)
        .set({ category: "Cabina", brand: "Marca", updatedAt: product.updatedAt })
        .where(eq(retailProduct.id, product.id))
        .returning();
      if (!labelled) throw new Error("Expected source product with legacy labels");
      const {
        stockAllocated: _allocation,
        categoryId: _category,
        subcategoryId: _subcategory,
        brandId: _brand,
        ...legacy
      } = labelled;
      await tx.execute(
        sql`update booksy_rehearsal.source_entity set target_hash=${fingerprint(legacy)} where kind='sourceProducts'`,
      );
      await tx.execute(sql`set constraints all immediate`);
      await tx.execute(sql`alter table retail_product drop column category_id,
        drop column subcategory_id, drop column brand_id`);
      await tx.execute(sql`drop table inventory_classification`);
      expect((await verifyBooksySourceModel(tx, model)).sourceAppointmentsVerified).toBe(true);
      for (const statement of migration.split("--> statement-breakpoint"))
        await tx.execute(sql.raw(statement));
      const [migrated] = await tx.select().from(retailProduct);
      expect(migrated?.categoryId).toBeString();
      expect(migrated?.brandId).toBeString();
      expect((await verifyBooksySourceModel(tx, model)).sourceAppointmentsVerified).toBe(true);
      await tx.execute(sql`update retail_product set category_id=null where id=${labelled.id}`);
      await expect(verifyBooksySourceModel(tx, model)).rejects.toThrow(
        "Native product/resource fields changed",
      );
      await tx.execute(sql`delete from inventory_classification where id=${migrated?.categoryId}`);
      await expect(verifyBooksySourceModel(tx, model)).rejects.toThrow(
        "Native product/resource fields changed",
      );
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
});

test("the stock opening fingerprint survives migration of a populated pre-position schema", async () => {
  const [opening] = await t.db
    .select({ position: stockMovement.ledgerPosition })
    .from(stockMovement);
  expect(opening?.position).toBeGreaterThan(0n);
  expect((await verifyBooksySourceModel(t.db, model)).sourceAppointmentsVerified).toBe(true);
  const migration = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0074_inventory_ledger_position.sql",
      import.meta.url,
    ),
  ).text();
  await expect(
    t.db.transaction(async (tx) => {
      await tx.execute(sql`drop trigger stamp_stock_movement_ledger on stock_movement`);
      await tx.execute(sql`drop function stamp_stock_movement_ledger()`);
      await tx.execute(sql`alter table stock_movement drop column ledger_position`);
      expect((await verifyBooksySourceModel(tx, model)).sourceAppointmentsVerified).toBe(true);
      for (const statement of migration.split("--> statement-breakpoint")) {
        await tx.execute(sql.raw(statement));
      }
      const [migrated] = await tx
        .select({ position: stockMovement.ledgerPosition })
        .from(stockMovement);
      expect(migrated?.position).toBe(0n);
      expect((await verifyBooksySourceModel(tx, model)).sourceAppointmentsVerified).toBe(true);
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
});

test("strict reconciliation rejects unmapped movements even with intact captured stock balances", async () => {
  const { hash } = await verifyBooksySourceModel(t.db, model, { exclusiveExtensions: true });
  const [product] = await t.db.select({ id: retailProduct.id }).from(retailProduct);
  if (!product) throw new Error("Expected the imported fixture product");
  await t.db.insert(stockMovement).values({
    productId: product.id,
    kind: "receive",
    quantityDelta: 1,
    reason: "Synthetic extra stock movement",
    idempotencyKey: "synthetic-extra-movement",
    requestHash: "synthetic-test",
  });
  await expect(loadBooksySourceModel(t.db, hash, { exclusiveExtensions: true })).rejects.toThrow(
    "unexpected products, stock movements or physical resources",
  );
});

test("candidate reconciliation rejects invented processing and an inactive staff interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "citame-native-audit-"));
  const { db } = t;
  try {
    await t.reset();
    await db.execute(
      sql`truncate booksy_rehearsal.source_entity,booksy_rehearsal.source_appointment,booksy_rehearsal.source_snapshot,booksy_rehearsal.entity,booksy_rehearsal.run`,
    );
    const source = fixture();
    const [booking] = source.appointments.splice(0);
    const [group] = source.groups.splice(0);
    if (!booking?.sourceCopy || !group) throw new Error("Expected a fixture booking");
    source.appointments = [booking];
    const addon = { id: 31, name: "Synthetic extra", price: 5, duration: 10, quantity: 1 };
    group.raw = {
      appointment: {
        subbookings: [
          { id: Number(booking.sourceCopy.itemRef), appliance_id: null, addons: [addon] },
        ],
      },
    };
    source.groups = [group];
    source.summary.groups = 1;
    source.summary.bookedServices = 1;
    booking.services[0]!.sourceUnpriced = true;
    booking.services[0]!.priceCents = 0;
    booking.services.push({
      serviceId: null,
      name: addon.name,
      durationMinutes: addon.duration,
      bufferMinutes: 0,
      priceCents: 500,
      currency: "EUR",
    });
    const originalBlock = { note: "Original block evidence" };
    const staffRef = source.base.staff[0]!.sourceId;
    source.base.timeOff = [
      {
        sourceId: `block-1:${staffRef}`,
        staffRef,
        startsAt: "2026-11-19T12:00:00Z",
        endsAt: "2026-11-19T12:30:00Z",
        reason: null,
        raw: originalBlock,
      },
    ];
    source.base.unprojected.push(
      { kind: "source_block_original", sourceId: "block-1", raw: originalBlock },
      { kind: "source_block_original", sourceId: "block-1", raw: { note: "Other evidence" } },
    );
    const context = source.contexts[booking.id]!;
    const note = context.rows[0]!;
    note.internalNote = "Synthetic original note";
    note.paid = false;
    context.rows.push({ ...note, servicePosition: 1, sourceRef: `${note.sourceRef}:extra` });
    source.contexts = { [booking.id]: context };
    const bytes = JSON.stringify({ businessId: source.businessId });
    const artifact = {
      path: "synthetic.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: Buffer.byteLength(bytes),
      kind: "synthetic",
    };
    await Bun.write(join(root, artifact.path), bytes);
    await stageBooksyArchive(db, root, {
      version: 1,
      businessId: source.businessId,
      fromDate: source.fromDate,
      timezone: "Europe/Madrid",
      complete: false,
      artifacts: [artifact],
      limitations: ["Synthetic fixture"],
    });
    const { kind: _kind, ...evidence } = artifact;
    source.base.artifacts = [evidence];
    await applyBooksyRehearsal(db, source.base, planBooksyTransfer(source.base).review.reviewHash);
    const { hash } = await storeBooksySourceModel(db, source);
    await db.insert(salonSettings).values({
      name: "Synthetic centre",
      timezone: source.base.timezone,
      reminderFirstLeadMinutes: null,
      reminderSecondLeadMinutes: null,
    });
    await db.insert(appointment).values({
      id: booking.id,
      clientId: booking.clientId,
      staffId: booking.staffId,
      visitGroupId: sourceUuid(source.businessId, "visitGroups", group.sourceId),
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
      status: booking.status,
      requestedStaffId: note.requestedStaffId,
      customerComment: context.customerComment,
      sourceBusinessMessage: context.businessMessage,
    });
    const [visit] = planNativeRehearsal(source).visits;
    if (!visit) throw new Error("Missing planned booking fixture");
    const savedServices = await db
      .insert(appointmentService)
      .values(
        visit.services.map((service, position) => ({
          ...service,
          appointmentId: booking.id,
          position,
        })),
      )
      .returning({ id: appointmentService.id, position: appointmentService.position });
    await db
      .insert(appointmentContext)
      .values(context.rows.map((row) => ({ ...row, appointmentId: booking.id })));
    const report = () => inspectNativeBooksy(db, hash, source.fromDate);
    const verified = await report();
    expect(verified.nativeFieldsVerified).toBe(true);
    expect(verified.canCutOver).toBe(false);
    expect(verified.bookingLinks).toBeUndefined();
    expect(verified.priceHolds).toBeUndefined();
    const verifyPaymentEvidence = () =>
      inspectNativeBooksy(db, hash, source.fromDate, { paymentEvidence: true });
    await expect(verifyPaymentEvidence()).rejects.toThrow(
      "Native payment holds differ from the archived reservation evidence",
    );
    await db
      .update(appointmentContext)
      .set({ sourcePaymentUnverified: true })
      .where(eq(appointmentContext.appointmentId, booking.id));
    expect((await verifyPaymentEvidence()).nativeFieldsVerified).toBe(true);
    const withPrivateLinks = await inspectNativeBooksy(db, hash, source.fromDate, {
      bookingLinks: true,
      priceHolds: "day",
    });
    expect(withPrivateLinks.bookingLinks).toEqual([
      {
        sourceBookingRef: group.sourceId,
        visitGroupId: sourceUuid(source.businessId, "visitGroups", group.sourceId),
        lines: [
          {
            sourceLineRef: booking.sourceCopy.itemRef,
            appointmentId: booking.id,
            services: savedServices
              .sort((a, b) => a.position - b.position)
              .map(({ id, position }) => ({ position, appointmentServiceId: id })),
          },
        ],
      },
    ]);
    expect(withPrivateLinks.priceHolds).toEqual([
      {
        sourceBookingRef: group.sourceId,
        sourceLineRef: booking.sourceCopy.itemRef,
        appointmentId: booking.id,
        servicePosition: 0,
        appointmentServiceId: savedServices.find(({ position }) => position === 0)!.id,
      },
    ]);
    expect(
      verified.blockers.translationAndCompletenessByReason.reduce(
        (total, issue) => total + issue.count,
        0,
      ),
    ).toBe(verified.blockers.translationAndCompleteness);
    const billingEvidence = {
      missingPrices: { serviceLines: 1, calendarLines: 1, visitGroups: 1 },
      invoice: { positive: 0, negative: 0, unknown: 1 },
      payment: { positive: 0, negative: 1, unknown: 0 },
    };
    expect(verified.blockers.billingEvidence).toEqual(billingEvidence);
    expect(verified.blockers.trackedNativeMappings).toEqual([
      { code: "unprojected_record", kind: "source_block_original", count: 1 },
    ]);
    expect(verified.day.billingEvidence).toEqual(billingEvidence);
    expect(verified.scheduleByStart).toEqual([
      {
        date: source.fromDate,
        staffId: booking.staffId,
        status: booking.status,
        calendarLines: 1,
        visitGroups: 1,
        frozenServices: 2,
      },
    ]);
    const emptyDay = await inspectNativeBooksy(db, hash, "2026-11-19");
    expect(emptyDay.scheduleByStart).toEqual(verified.scheduleByStart);
    expect(emptyDay.day.billingEvidence.missingPrices).toEqual({
      serviceLines: 0,
      calendarLines: 0,
      visitGroups: 0,
    });
    expect(emptyDay.blockers.billingEvidence).toEqual(billingEvidence);
    const allPriceHolds = await inspectNativeBooksy(db, hash, "2026-11-19", { priceHolds: "all" });
    expect(allPriceHolds.day).toEqual(emptyDay.day);
    expect(allPriceHolds.priceHolds).toEqual(withPrivateLinks.priceHolds);
    const extra = savedServices.find(({ position }) => position === 1);
    if (!extra) throw new Error("Missing frozen extra fixture");
    const savedExtra = eq(appointmentService.id, extra.id);
    await db
      .update(appointmentService)
      .set({ ...visit.services[0]!, position: 0 })
      .where(savedExtra);
    await expect(report()).rejects.toThrow("did not reconcile the source schedule");
    await db
      .update(appointmentService)
      .set({ ...visit.services[1]!, sourceUnpriced: false, position: 1 })
      .where(savedExtra);
    await db.update(salonSettings).set({ timezone: "UTC" });
    await expect(report()).rejects.toThrow("must use the source timezone");
    await db.update(salonSettings).set({
      timezone: source.base.timezone,
      reminderFirstLeadMinutes: 1440,
    });
    await expect(report()).rejects.toThrow("pause appointment reminders");
    await db.update(salonSettings).set({ reminderFirstLeadMinutes: null });

    const primary = savedServices.find(({ position }) => position === 0);
    if (!primary) throw new Error("Missing frozen primary service fixture");
    const savedLine = eq(appointmentService.id, primary.id);
    await db
      .update(appointmentService)
      .set({ processingStartMinutes: 15, processingMinutes: 20 })
      .where(savedLine);
    await expect(report()).rejects.toThrow("did not reconcile the source schedule");

    await db
      .update(appointmentService)
      .set({ processingStartMinutes: null, processingMinutes: null })
      .where(savedLine);
    // Simulate a damaged restored row in the dedicated fixture database.
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table staff_reservation disable trigger staff_reservation_align`);
      await tx
        .update(staffReservation)
        .set({ active: false })
        .where(eq(staffReservation.appointmentId, booking.id));
      await tx.execute(sql`set constraints all immediate`);
      await tx.execute(sql`alter table staff_reservation enable trigger staff_reservation_align`);
    });
    await expect(report()).rejects.toThrow("did not reconcile the source schedule");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consultation calendar exposes flags without private text and only the owner can read source details", async () => {
  const principal: Principal = {
    userId: "synthetic-owner",
    email: "owner@example.invalid",
    name: "Synthetic owner",
    role: "owner",
    staffId: null,
    clientId: null,
  };
  const app = new Hono<AppEnv>()
    .onError((e, c) =>
      e instanceof DomainError ? respondError(c, e) : c.json({ error: "internal" }, 500),
    )
    .use("*", async (c, next) => {
      c.set("principal", {
        ...principal,
        role: c.req.header("x-test-role") === "client" ? "client" : "owner",
      });
      await next();
    })
    .route("/", booksySourceRoutes(t.db, model));
  const result = await app.request("/calendar?from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z");
  expect(result.status).toBe(200);
  const text = await result.text();
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("CLIENT COMMENT");
  const calendar = calendarResponseSchema.parse(JSON.parse(text));
  expect(calendar.appointments).toHaveLength(2);
  expect(calendar.importSnapshot?.readOnly).toBe(true);
  const detail = await app.request(`/${model.appointments[0]!.id}/context`);
  expect(detail.status).toBe(200);
  const context = (await detail.json()) as { rows: { internalNote: string }[] };
  expect(context.rows[0]!.internalNote).toBe("PRIVATE\u0000 note");
  expect(
    (
      await app.request(`/${model.appointments[0]!.id}/context`, {
        headers: { "x-test-role": "client" },
      })
    ).status,
  ).toBe(403);
});
test("source instants use Madrid DST and unquoted display labels cannot become numeric prices", () => {
  expect(sourceInstant("2026-11-18T00:00")).toBe("2026-11-17T23:00:00Z");
  expect(sourceInstant("2027-04-15T12:10")).toBe("2027-04-15T10:10:00Z");
  expect(() => sourceInstant("2027-03-28T02:30")).toThrow();
  expect(booksyCents("1.299,00 €")).toBe(129900);
  expect(booksyCents(12.5)).toBe(1250);
  expect(() => booksyCents("No mostrar")).toThrow();
});
test.each(["archive", "native"] as const)(
  "%s consultation allows login and calendar reads only",
  async (mode) => {
    const cache = await createTestValkey("booksy_readonly_guard");
    const deps = {
      db: t.db,
      valkey: cache.client,
      config: loadConfig({
        BETTER_AUTH_SECRET: "synthetic-booksy-consultation-secret-0123456789",
        VALKEY_KEY_PREFIX: cache.prefix,
      }),
    };
    const app = createApp({
      ...deps,
      ...(mode === "archive"
        ? { booksyConsultation: model }
        : {
            booksyNativePreview: {
              system: "booksy",
              readOnly: true,
              capturedAt: model.capturedAt,
              fromDate: model.fromDate,
              throughDate: model.throughDate,
            },
          }),
    });
    try {
      const origin = new URL(deps.config.auth.baseURL).origin;
      const email = "review-owner@example.invalid";
      const password = "synthetic-consultation-password";
      const auth = createAuth(deps);
      try {
        await createAccount(
          { db: t.db, auth },
          { email, password, role: "owner", name: "Consultation test owner" },
        );
      } finally {
        await auth.mailer.stop();
      }
      await app.ready();
      expect((await app.request("/health")).status).toBe(200);
      const login = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token=");
      const headers = { cookie, origin };
      const session = await app.request("/api/auth/get-session", { headers });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ user: { email } });
      const calendar = await app.request(
        "/appointments/calendar?from=2026-11-18T00:00:00Z&to=2026-11-19T00:00:00Z",
        { headers },
      );
      expect(calendar.status).toBe(200);
      expect(await calendar.json()).toMatchObject({ importSnapshot: { readOnly: true } });
      for (const [method, path] of [
        ["POST", "/appointments"],
        ["PATCH", "/admin/clients/example"],
        ["DELETE", "/appointments/example"],
        ["POST", "/sync/push"],
        ["POST", "/api/auth/sign-up/email"],
        ["POST", "/api/auth/request-password-reset"],
        ["GET", "/api/auth/verify-email"],
        ["HEAD", "/api/auth/verify-email"],
      ] as const) {
        expect((await app.request(path, { method, headers })).status).toBe(403);
      }
      expect(await t.db.select().from(appointment)).toHaveLength(0);
    } finally {
      app.drain();
      await app.shutdown();
      await cache.close();
    }
  },
);
