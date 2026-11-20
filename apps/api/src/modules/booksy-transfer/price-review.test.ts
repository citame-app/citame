import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bindBooksyPriceReview, prepareBooksyPriceReview } from "./price-review";
import type { BooksySourceReadModel } from "./source-read-model";

const startsAt = "2026-11-19T09:00:00Z";
const date = "2026-11-19";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const capture = {
  appointment: {
    appointment_uid: 101,
    total: "0,00 €",
    total_value: 0,
    total_discount_amount: 0,
    subbookings: [{ id: 301, booked_from: "2026-11-19T10:00:00", service_price: "No mostrar" }],
  },
};
function model(raw: Record<string, unknown> = capture) {
  return {
    businessId: "99",
    appointments: [
      {
        id: "01989f00-0000-7000-8000-000000000301",
        startsAt,
        sourceCopy: { itemRef: "301", groupRef: "101", businessId: "99" },
        services: [{ sourceUnpriced: true, currency: "EUR", priceCents: 0 }],
      },
    ],
    base: { timezone: "Europe/Madrid" },
    groups: [{ sourceId: "101", ids: ["01989f00-0000-7000-8000-000000000301"], raw }],
  } as unknown as BooksySourceReadModel;
}
function apiArtifact(payload = capture, parsed = payload) {
  const bytes = Buffer.from(
    JSON.stringify({
      businessId: "99",
      kind: "booksy-api-response",
      source: "https://es.booksy.com/core/v2/business_api/me/businesses/99/appointments/101/",
      data: { body: JSON.stringify(payload), data: parsed },
    }),
  );
  return [{ path: "details.json", sha256: sha(bytes) }, bytes] as const;
}

test("verifies the raw appointment evidence and leaves a zero group total unresolved", () => {
  const review = prepareBooksyPriceReview(model());
  expect(() => review.result()).toThrow("lacks its verified original");
  review.inspect(
    ...apiArtifact(capture, { appointment: { ...capture.appointment, total_value: 10 } }),
  );
  expect(() => review.result()).toThrow("lacks its verified original");
  review.inspect(...apiArtifact());
  expect(review.result()).toMatchObject({
    unresolvedServices: 1,
    canCutOver: false,
    groups: [
      {
        groupTotalCents: 0,
        comparison: "equals_visible_lines",
        lines: [{ itemRef: "301", servicePosition: 0, evidence: "hidden" }],
        artifactSha256: [apiArtifact()[0].sha256],
      },
    ],
  });
});

test("rejects an altered date, a hold on an add-on and known prices that differ from the original", () => {
  const moved = model();
  moved.appointments[0]!.startsAt = "2026-11-19T10:00:00Z";
  expect(() => prepareBooksyPriceReview(moved)).toThrow(
    "pricing and source service positions differ",
  );
  const addon = model();
  addon.appointments[0]!.services.push(addon.appointments[0]!.services[0]!);
  expect(() => prepareBooksyPriceReview(addon)).toThrow("add-on position");
  const raw = structuredClone(capture);
  Object.assign(raw.appointment.subbookings[0]!, { addons: [{ price: "4.00", quantity: 1 }] });
  const changed = model(raw);
  changed.appointments[0]!.services.push({
    ...changed.appointments[0]!.services[0]!,
    sourceUnpriced: undefined,
    priceCents: 300,
  });
  expect(() => prepareBooksyPriceReview(changed)).toThrow(
    "pricing and source service positions differ",
  );
});

test("links a pending service to its appointment on the salon's local date", () => {
  const raw = structuredClone(capture);
  raw.appointment.subbookings[0]!.booked_from = "2026-11-19T00:30:00";
  const input = model(raw);
  const appointment = input.appointments[0]!;
  appointment.startsAt = "2026-11-18T23:30:00Z";
  const review = prepareBooksyPriceReview(input);
  review.inspect(...apiArtifact(raw));
  const result = review.result();
  expect(result.pendingByDate).toEqual([{ date: "2026-11-19", unresolvedServices: 1 }]);
  expect(result.groups[0]?.lines[0]).toMatchObject({
    appointmentId: appointment.id,
    calendarDate: "2026-11-19",
    calendarPath: `/admin/calendar?date=2026-11-19&view=day&appointment=${appointment.id}`,
    evidence: "hidden",
  });
});

test("counts pending services on each salon day in chronological order", () => {
  const raw = structuredClone(capture);
  raw.appointment.subbookings.push(
    { id: 302, booked_from: "2026-11-20T10:00:00", service_price: "No mostrar" },
    { id: 303, booked_from: "2026-11-19T11:00:00", service_price: "No mostrar" },
  );
  const input = model(raw);
  const original = input.appointments[0]!;
  for (const [id, startsAt] of [
    ["302", "2026-11-20T09:00:00Z"],
    ["303", "2026-11-19T10:00:00Z"],
  ] as const) {
    const appointment = {
      ...original,
      id: `01989f00-0000-7000-8000-000000000${id}`,
      sourceCopy: { ...original.sourceCopy!, itemRef: id },
      startsAt,
    };
    input.appointments.push(appointment);
    input.groups[0]!.ids.unshift(appointment.id);
  }
  const review = prepareBooksyPriceReview(input);
  review.inspect(...apiArtifact(raw));
  expect(review.result().pendingByDate).toEqual([
    { date: "2026-11-19", unresolvedServices: 2 },
    { date: "2026-11-20", unresolvedServices: 1 },
  ]);
});

test("binds overlapping local-day holds to native service IDs and rejects missing or changed positions", () => {
  const raw = structuredClone(capture);
  raw.appointment.subbookings[0]!.booked_from = "2026-11-19T23:45:00";
  const input = model(raw);
  const appointment = input.appointments[0]!;
  appointment.startsAt = "2026-11-19T22:45:00Z";
  appointment.endsAt = "2026-11-19T23:15:00Z";
  const review = prepareBooksyPriceReview(input);
  review.inspect(...apiArtifact(raw));
  const archived = review.result();
  const nextDate = "2026-11-20";
  const native = {
    sourceBookingRef: "101",
    sourceLineRef: "301",
    appointmentId: appointment.id,
    servicePosition: 0,
    appointmentServiceId: "01989f00-0000-7000-8000-000000000401",
  };
  expect(bindBooksyPriceReview(input, archived, nextDate, [native])).toMatchObject({
    date: nextDate,
    unresolvedServices: 1,
    groups: [
      {
        lines: [
          {
            appointmentServiceId: native.appointmentServiceId,
            calendarDate: date,
            calendarPath: `/admin/calendar?date=${date}&view=day&appointment=${appointment.id}`,
          },
        ],
      },
    ],
    canCutOver: false,
  });
  expect(() => bindBooksyPriceReview(input, archived, nextDate, [])).toThrow(
    "does not match its native service",
  );
  expect(() =>
    bindBooksyPriceReview(input, archived, nextDate, [{ ...native, sourceBookingRef: "102" }]),
  ).toThrow("does not match its native service");
  expect(() => bindBooksyPriceReview(input, archived, nextDate, [native, native])).toThrow(
    "Repeated native pricing position",
  );
  appointment.endsAt = "2026-11-19T23:00:00Z";
  expect(bindBooksyPriceReview(input, archived, nextDate, []).groups).toEqual([]);
  expect(bindBooksyPriceReview(input, archived, undefined, [native])).toMatchObject({
    fromDate: input.fromDate,
    throughDate: input.throughDate,
    pendingByDate: archived.pendingByDate,
    groups: [{ lines: [{ appointmentServiceId: native.appointmentServiceId }] }],
    unresolvedServices: 1,
    canCutOver: false,
  });
  expect(() =>
    bindBooksyPriceReview(input, archived, undefined, [
      native,
      { ...native, servicePosition: native.servicePosition + 1 },
    ]),
  ).toThrow("A native service row cannot represent two archived prices");
  expect(() => bindBooksyPriceReview(input, archived, undefined, [])).toThrow(
    "does not match its native service",
  );
  expect(() => bindBooksyPriceReview(input, archived, nextDate, [native])).toThrow(
    "missing from the archived review",
  );
});

test("a screen must bind the recorded discount and service identity to verified evidence", () => {
  const text =
    "RESERVA DE GRUPO\nHeader\nSynthetic service\n30min\n0,00 €\nDescuento\n-25,00 €\nTotal\n0,00 €\nA pagar\n0,00 €";
  const cardText = "Synthetic service";
  const originals = [
    {
      source: "booksy_visible_calendar_card",
      ref: "a-101",
      date,
      appointmentRef: "101",
      itemElementId: "cc-301",
      text: cardText,
      textSha256: sha(cardText),
    },
    {
      source: "booksy_visible_drawer",
      ref: "a-101",
      date,
      calendarRange: { start: "10:00" },
      text,
      textSha256: sha(text),
    },
    {},
    {},
    {},
  ].map((value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { bytes: bytes.toString("base64"), sha256: sha(bytes) };
  });
  const bytes = Buffer.from(
    JSON.stringify({
      kind: "booksy-reviewed-visible-booking",
      businessId: "99",
      parentHash: "a".repeat(64),
      originals,
    }),
  );
  const artifact = { path: "visible-booking.json", sha256: sha(bytes) };
  const group = {
    kind: "booksy-reviewed-visible-booking",
    itemRef: "301",
    evidenceSha256: artifact.sha256,
    financialHold: {
      displayedService: "0,00 €",
      displayedTotal: "0,00 €",
      discount: "-25,00 €",
      displayedDue: "0,00 €",
    },
  };
  const unrelated = Buffer.from("{}");
  const forged = prepareBooksyPriceReview(model({ ...group, evidenceSha256: sha(unrelated) }));
  expect(() => forged.inspect({ ...artifact, sha256: sha(unrelated) }, unrelated)).toThrow();
  const mismatch = prepareBooksyPriceReview(
    model({ ...group, financialHold: { ...group.financialHold, discount: "-23,00 €" } }),
  );
  mismatch.inspect(artifact, bytes);
  expect(() => mismatch.result()).toThrow("lacks its verified original");
  const review = prepareBooksyPriceReview(model(group));
  review.inspect(artifact, bytes);
  expect(review.result()).toMatchObject({
    groups: [{ comparison: "discounted_screen", lines: [{ evidence: "discounted_screen" }] }],
    canCutOver: false,
  });
});
