import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookingReportEvidence, reconcileBooksyBookingReport } from "./booking-report";
import { auditCalendarCoverage } from "./calendar-coverage";
import { transferFixture } from "./fixtures";
import { fingerprint } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

const base = transferFixture();
const model: BooksySourceReadModel = {
  version: 1,
  businessId: base.businessId,
  base,
  businessName: "Fixture",
  fromDate: "2026-10-20",
  throughDate: "2026-11-30",
  capturedAt: base.capturedAt,
  lastAppointmentProven: false,
  lastObservedAppointmentAt: null,
  appointments: [],
  contexts: {},
  groups: [],
  inventory: [],
  resources: [],
  summary: {
    groups: 0,
    bookedServices: 0,
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

test("a cutover window distinguishes full, stale, partial and out-of-snapshot days", () => {
  const audit = auditCalendarCoverage(
    {
      ...model,
      fromDate: "2026-11-23",
      throughDate: "2026-11-25",
      base: { ...base, staff: base.staff.map((staff) => ({ ...staff, sourceId: "10" })) },
      lastObservedAppointmentAt: "2026-11-24T09:35:00Z",
    },
    { from: "2026-11-22", to: "2026-11-26", atOrAfter: "2026-11-18T13:13:00+01:00" },
  );
  function inspect(date: string, capturedAt: string, resourceIds: number[], sha: string) {
    const body = {
      start_date: date,
      end_date: date,
      resources_count: resourceIds.length,
      resources: resourceIds.map((id) => ({ id })),
      bookings: {},
    };
    audit.inspect(
      {
        kind: "booksy-api-response",
        businessId: model.businessId,
        capturedAt,
        source: `https://es.booksy.com/core/v2/business_api/me/businesses/${model.businessId}/calendar`,
        data: { body: JSON.stringify(body), data: body },
      },
      sha,
    );
  }
  inspect("2026-11-23", "2026-11-17T23:00:00Z", [10], "a".repeat(64));
  inspect("2026-11-23", "2026-11-18T12:14:00Z", [20], "b".repeat(64));
  inspect("2026-11-24", "2026-11-18T12:13:00Z", [10], "c".repeat(64));
  inspect("2026-11-26", "2026-11-18T12:14:00Z", [10], "d".repeat(64));
  expect(audit.result()).toMatchObject({
    daysRequested: 5,
    currentDays: 1,
    staleDays: 1,
    missingDays: 1,
    outsideSnapshotDays: 2,
    outsideSnapshotObservedDays: 1,
    outsideSnapshotObservedAtOrAfterCutoff: 1,
    timezone: "Europe/Madrid",
    lastObservedAppointmentAt: "2026-11-24T09:35:00Z",
    lastAppointmentProven: false,
    canCutOver: false,
    days: [
      { date: "2026-11-23", state: "stale", lastFullObservation: { sha256: "a".repeat(64) } },
      { date: "2026-11-24", state: "current", lastFullObservation: { sha256: "c".repeat(64) } },
      { date: "2026-11-25", state: "missing", lastFullObservation: null },
      {
        date: "2026-11-26",
        inSnapshot: false,
        state: "current",
        lastFullObservation: { sha256: "d".repeat(64) },
      },
    ],
  });
});

test("the inclusive audit stops at the largest four-digit local date", () => {
  const lastDate = "9999-12-31";
  const audit = auditCalendarCoverage(
    { ...model, fromDate: lastDate, throughDate: lastDate },
    { from: lastDate, to: lastDate, atOrAfter: "2026-11-18T12:13:00Z" },
  );
  expect(audit.result()).toMatchObject({
    daysRequested: 1,
    missingDays: 1,
    outsideSnapshotDays: 0,
    days: [{ date: lastDate, state: "missing" }],
  });
});

function booking(itemRef: string, startsAt: string): BooksySourceReadModel["appointments"][number] {
  return {
    id: itemRef,
    startsAt,
    endsAt: startsAt,
    clientId: "client",
    staffId: "staff",
    clientName: "Private customer name",
    serviceNames: [],
    status: "booked",
    notes: "Private notes",
    version: 1,
    services: [],
    createdAt: base.capturedAt,
    updatedAt: base.capturedAt,
    sourceCopy: {
      system: "booksy",
      itemRef,
      groupRef: itemRef,
      businessId: model.businessId,
      capturedAt: base.capturedAt,
      readOnly: true,
    },
  };
}

const row = (id: string, date: string, status = "Confirmadas") => ({ id, date, status });
const evidence = (
  reportRows: ReturnType<typeof row>[],
  window = ["2026-11-19", "2026-11-30"],
  calendar?: unknown,
) =>
  bookingReportEvidence.parse({
    version: 1,
    type: "booksy_visible_future_booking_report_comparison",
    snapshotHash: "a".repeat(64),
    timezone: "Europe/Madrid",
    reportGeneratedAt: "2026-11-18T13:13:00+01:00",
    window,
    pagesInspected: { first: 1, last: 14, total: 54 },
    followingMonthSelectable: false,
    counts: { matching: 999 },
    canCutOver: true,
    evidence: { reportRows, calendar },
  });

test("reconciles by source reference, local minute and status and retains conflicting evidence", () => {
  const observed = row("4", "24/11/26 10:35");
  const report = evidence(
    [
      row("1", "24/11/26 10:35"),
      row("1", "24/11/2026 10:35"),
      row("2", "24/11/26 10:35", "Canceladas"),
      row("3", "24/11/26 11:00"),
      observed,
      row("5", "24/11/26 10:35", "Canceladas"),
      row("6", "24/11/26 10:35"),
      row("6", "24/11/26 11:35"),
    ],
    undefined,
    {
      date: "2026-11-24",
      filter: "working",
      observedItemRefs: ["4", "7"],
      confirmedExtra: { ...observed, interval: "10:35 - 11:45" },
    },
  );
  const result = reconcileBooksyBookingReport(
    {
      ...model,
      appointments: [
        booking("1", "2026-11-24T09:35:45Z"),
        booking("2", "2026-11-24T09:35:00Z"),
        booking("3", "2026-11-18T09:35:00Z"),
        booking("6", "2026-11-24T09:35:00Z"),
        booking("7", "2026-11-24T09:35:00Z"),
        booking("8", "2026-11-18T09:35:00Z"),
      ],
    },
    report,
  );
  expect(result.matching).toEqual(["1"]);
  expect(result.repeatedRows).toBe(1);
  expect(result.changed).toEqual([
    { ref: "2", fields: ["status"] },
    { ref: "3", fields: ["minute"] },
  ]);
  expect(result.reportOnlyConfirmed).toEqual([
    { ref: "4", minute: "2026-11-24T10:35", corroboratedByCalendar: true },
  ]);
  expect(result.reportOnlyCancelled).toEqual([{ ref: "5", minute: "2026-11-24T10:35" }]);
  expect(result.contradictoryRows).toEqual(["6"]);
  expect(result.archivedNotInInspectedRows).toEqual([
    { ref: "7", date: "2026-11-24", visibleInCalendarObservation: true },
  ]);
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(result.canCutOver).toBe(false);
  expect(result.lastAppointmentProven).toBe(false);
  expect(result.allReportPagesInspected).toBe(false);
  expect(result.calendarObservation?.capturedAt).toBeNull();
});

test("an ambiguous Madrid minute cannot prove that either time offset was booked", () => {
  const report = evidence([row("1", "25/10/26 02:30")], ["2026-10-25", "2026-10-25"]);
  const result = reconcileBooksyBookingReport(
    { ...model, appointments: [booking("1", "2026-10-25T00:30:00Z")] },
    report,
  );
  expect(result.ambiguousMinutes).toEqual(["1"]);
  expect(result.matching).toHaveLength(0);
  expect(result.archivedNotInInspectedRows).toHaveLength(0);
});

test("rejects a report row outside the observed interval and ambiguous archived identity", () => {
  expect(() => reconcileBooksyBookingReport(model, evidence([row("1", "01/12/26 09:00")]))).toThrow(
    "declared interval",
  );
  const duplicate = booking("1", "2026-11-24T09:35:00Z");
  expect(() =>
    reconcileBooksyBookingReport(
      { ...model, appointments: [duplicate, duplicate] },
      evidence([row("1", "24/11/26 10:35")]),
    ),
  ).toThrow("unique source identity");
});

test("refuses invalid or reversed time ranges as calendar corroboration", () => {
  const reported = row("1", "24/11/26 10:35");
  for (const interval of ["10:35 - 99:99", "10:35 - 09:30"]) {
    expect(() =>
      evidence([reported], undefined, {
        date: "2026-11-24",
        filter: "working",
        observedItemRefs: ["1"],
        confirmedExtra: { ...reported, interval },
      }),
    ).toThrow();
  }
});

test("the offline commands accept only private hash-linked inputs and print counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "citame-report-fixture-"));
  try {
    const privateRef = "9876543212345";
    const absentRef = "7896543212345";
    const capture = {
      start_date: "2026-11-24",
      end_date: "2026-11-24",
      resources_count: 1,
      resources: [{ id: 10 }],
      bookings: { [absentRef]: { id: Number(absentRef) } },
    };
    const source = `https://es.booksy.com/core/v2/business_api/me/businesses/${model.businessId}/calendar`;
    const capturedAt = "2026-11-18T12:20:00Z";
    const original = JSON.stringify({
      kind: "booksy-api-response",
      businessId: model.businessId,
      capturedAt,
      source,
      data: { body: JSON.stringify(capture), data: capture },
    });
    const artifactPath = join(directory, "original.json");
    writeFileSync(artifactPath, original, { mode: 0o600 });
    const artifact = {
      path: "original.json",
      sha256: createHash("sha256").update(original).digest("hex"),
      bytes: Buffer.byteLength(original),
      capturedAt,
      source,
    };
    const snapshot = {
      ...model,
      lastObservedAppointmentAt: "2026-11-24T09:35:00Z",
      appointments: [booking(absentRef, "2026-11-24T09:35:00Z")],
      base: {
        ...base,
        staff: base.staff.map((member) => ({ ...member, sourceId: "10" })),
        artifacts: [artifact],
      },
    };
    const snapshotHash = fingerprint(snapshot);
    const snapshotPath = join(directory, `source-snapshot-${snapshotHash}.json`);
    writeFileSync(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
    const report = evidence([row(privateRef, "24/11/26 10:35")]);
    const writeReport = (record: typeof report) => {
      const bytes = JSON.stringify(record);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const path = join(directory, `booking-report-reconciliation-${sha}.json`);
      writeFileSync(path, bytes, { mode: 0o600 });
      return path;
    };
    const call = (path: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dirname, "../../scripts/booksy-reconcile-booking-report.ts"),
          snapshotPath,
          path,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    expect(call(writeReport(report)).exitCode).toBe(1);
    const reportPath = writeReport({ ...report, snapshotHash });
    chmodSync(reportPath, 0o644);
    expect(call(reportPath).exitCode).toBe(1);
    chmodSync(reportPath, 0o600);
    const result = call(reportPath);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const stdout = result.stdout.toString();
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      reportOnlyConfirmed: 1,
      archivedNotInInspectedRows: 1,
      archiveArtifactsVerified: 1,
      missingWithCalendarPresenceAtOrAfterReport: 1,
      fullCalendarCoverage: {
        days: 12,
        observedDays: 1,
        observedDaysAtOrAfterReport: 1,
      },
      lastAppointmentProven: false,
      canCutOver: false,
    });
    expect(stdout).not.toContain(privateRef);
    expect(stdout).not.toContain(absentRef);
    const receipt = join(directory, summary.receipt);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
    const coverage = JSON.parse(readFileSync(receipt, "utf8")).fullCalendarCoverage;
    expect(coverage.find((day: { date: string }) => day.date === "2026-11-24")).toEqual({
      date: "2026-11-24",
      lastFullObservation: { at: capturedAt, sha256: artifact.sha256 },
    });
    expect(coverage.find((day: { date: string }) => day.date === "2026-11-25")).toEqual({
      date: "2026-11-25",
      lastFullObservation: null,
    });
    expect(call(reportPath).stdout.toString()).toBe(stdout);
    const auditWindow = () =>
      Bun.spawnSync([
        process.execPath,
        join(import.meta.dirname, "../../scripts/booksy-audit-calendar-window.ts"),
        snapshotPath,
        "2026-11-24",
        "2026-11-25",
        capturedAt,
      ]);
    const audit = auditWindow();
    expect(audit.exitCode).toBe(0);
    const auditOutput = audit.stdout.toString();
    const windowSummary = JSON.parse(auditOutput);
    expect(windowSummary).toMatchObject({
      daysRequested: 2,
      currentDays: 1,
      staleDays: 0,
      missingDays: 1,
      archiveArtifactsVerified: 1,
      canCutOver: false,
    });
    expect(auditOutput).not.toContain(absentRef);
    expect(auditOutput).not.toContain(snapshot.lastObservedAppointmentAt);
    expect(statSync(join(directory, windowSummary.receipt)).mode & 0o777).toBe(0o600);
    chmodSync(receipt, 0o644);
    expect(call(reportPath).exitCode).toBe(1);
    chmodSync(receipt, 0o600);
    const copy = join(directory, "existing-copy.json");
    renameSync(receipt, copy);
    symlinkSync(copy, receipt);
    expect(call(reportPath).exitCode).toBe(1);
    renameSync(copy, receipt);
    writeFileSync(artifactPath, `${original}\n`);
    expect(call(reportPath).exitCode).toBe(1);
    expect(auditWindow().exitCode).toBe(1);
    writeFileSync(artifactPath, original);
    writeFileSync(reportPath, JSON.stringify({ ...report, snapshotHash }, null, 2));
    expect(call(reportPath).exitCode).toBe(1);
    expect(
      readdirSync(directory).filter((name) => name.startsWith("booking-report-offline-")).length,
    ).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
