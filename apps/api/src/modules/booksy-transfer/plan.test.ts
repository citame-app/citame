import { expect, test } from "bun:test";
import { transferFixture } from "./fixtures";
import {
  fingerprint,
  matchesBooksyTarget,
  planBooksyTransfer,
  sourceUuid,
  summarizeTransferIssues,
  targetFingerprint,
} from "./plan";

test("public issue counts omit source references and preserve each distinct reason and area", () => {
  const issue = {
    code: "unprojected_record",
    kind: "comments",
    sourceId: "private-ref",
    detail: "Pseudonymous detail",
  };
  const issues = [
    issue,
    { ...issue, kind: "payments" },
    { ...issue, code: "coverage_incomplete" },
    { ...issue, sourceId: "another-private-ref" },
  ];
  expect(summarizeTransferIssues(issues)).toEqual([
    { code: "coverage_incomplete", kind: "comments", count: 1 },
    { code: "unprojected_record", kind: "comments", count: 2 },
    { code: "unprojected_record", kind: "payments", count: 1 },
  ]);
});

test("old staff receipts survive the absence migration and still detect a portrait removal", () => {
  const original = { id: "staff1", active: true };
  expect(targetFingerprint("staff", { ...original, portraitAbsenceVersion: null })).toBe(
    fingerprint(original),
  );
  expect(targetFingerprint("staff", { ...original, portraitAbsenceVersion: "removal1" })).not.toBe(
    fingerprint(original),
  );
});

test("old service receipts survive the migration and still detect a change to unknown pricing", () => {
  const original = { id: "booked-service", priceCents: 0 };
  expect(targetFingerprint("appointmentServices", { ...original, peakSurchargeCents: null })).toBe(
    fingerprint(original),
  );
  expect(targetFingerprint("appointmentServices", { ...original, peakSurchargeCents: 1 })).not.toBe(
    fingerprint(original),
  );
  expect(targetFingerprint("appointmentServices", { ...original, sourceUnpriced: false })).toBe(
    fingerprint(original),
  );
  expect(targetFingerprint("appointmentServices", { ...original, sourceUnpriced: true })).not.toBe(
    fingerprint(original),
  );
});

test("catalogue migration preserves a legacy receipt without masking later catalogue edits", () => {
  const original = { id: "catalogue-service", category: " Facials  ", priceCents: 2500 };
  const migrated = {
    ...original,
    category: "Facials",
    sortOrder: 0,
    onlineBooking: true,
    clientInstructions: null,
    bookingIntervalMinutes: null,
    priceType: "fixed",
  };
  const expected = fingerprint(original);
  expect(matchesBooksyTarget("services", migrated, expected, original.category)).toBe(true);
  expect(
    matchesBooksyTarget(
      "services",
      { ...migrated, category: "Nails" },
      expected,
      original.category,
    ),
  ).toBe(false);
  expect(
    matchesBooksyTarget("services", { ...migrated, sortOrder: 1 }, expected, original.category),
  ).toBe(false);
});

test("old appointment receipts still verify and detect unexpected imported group membership", () => {
  const original = { id: "booked-visit" };
  expect(targetFingerprint("appointments", { ...original, visitGroupId: null })).toBe(
    fingerprint(original),
  );
  expect(targetFingerprint("appointments", { ...original, visitGroupId: "group1" })).not.toBe(
    fingerprint(original),
  );
});

test("tomorrow is salon-local midnight, identifiers are scoped and incomplete coverage never authorizes cutover", () => {
  const input = transferFixture();
  const p = planBooksyTransfer(input);
  expect(p.review.canRehearse).toBe(true);
  expect(p.review.canCutOver).toBe(false);
  expect(p.review.counts.bookedServices).toBe(1);
  expect(p.review.blockers.some((b) => b.code === "last_appointment_unproven")).toBe(true);
  expect(sourceUuid(input.businessId, "clients", "1")).not.toBe(
    sourceUuid(input.businessId, "staff", "1"),
  );
  expect(sourceUuid("other", "clients", "1")).not.toBe(
    sourceUuid(input.businessId, "clients", "1"),
  );
  input.appointments[0]!.startsAt = "2026-11-17T22:59:00Z";
  expect(planBooksyTransfer(input).review.issues.some((i) => i.code === "outside_scope")).toBe(
    true,
  );
});
test("duplicates, missing source references and service duration loss block the whole projection", () => {
  const input = transferFixture();
  input.staff.push({ ...input.staff[0]! });
  input.appointments[0]!.clientRef = "missing";
  input.appointments[0]!.services[0]!.durationMinutes = 45;
  const p = planBooksyTransfer(input);
  expect(p.review.canRehearse).toBe(false);
  expect(p.review.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining(["duplicate_source_id", "missing_reference", "service_plan_mismatch"]),
  );
});

test("claiming complete horizon coverage requires the last imported appointment date", () => {
  const input = transferFixture();
  input.horizon.lastAppointmentProven = true;
  input.horizon.lastAppointmentAt = null;
  const { review } = planBooksyTransfer(input);
  expect(review.issues.map((issue) => issue.code)).toContain("last_appointment_mismatch");
  expect(review.coverageComplete).toBe(false);
  expect(review.canRehearse).toBe(false);
});
test("review identity binds unknown raw fields, source snapshot, comments and service order", () => {
  const input = transferFixture();
  expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  const before = planBooksyTransfer(input).review.reviewHash;
  input.staff[0]!.raw.unknownSourceField = "changed";
  expect(planBooksyTransfer(input).review.reviewHash).not.toBe(before);
});
