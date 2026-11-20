import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { collectBookingAbsences } from "../modules/booksy-transfer/absence-evidence";
import {
  bookingReportEvidence,
  reconcileBooksyBookingReport,
} from "../modules/booksy-transfer/booking-report";
import { fingerprint } from "../modules/booksy-transfer/plan";
import {
  privateWriteVerified,
  readPrivateArchiveFile,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";

if (import.meta.main) {
  try {
    const [snapshotPath, reportPath, ...extra] = Bun.argv.slice(2);
    if (!snapshotPath || !reportPath || extra.length)
      throw new Error("Expected a private snapshot and booking report evidence");
    const [snapshot, input] = await Promise.all([
      readPrivateBooksySnapshot(snapshotPath),
      readPrivateArchiveFile(reportPath),
    ]);
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    if (basename(input.path) !== `booking-report-reconciliation-${hash}.json`)
      throw new Error("Report evidence hash differs");
    const report = bookingReportEvidence.parse(JSON.parse(input.bytes.toString("utf8")));
    if (report.snapshotHash !== snapshot.hash)
      throw new Error("Report and snapshot are from different reviews");

    const result = reconcileBooksyBookingReport(snapshot.model, report);
    const absences = collectBookingAbsences(
      snapshot.model,
      snapshot.model,
      result.archivedNotInInspectedRows.map(({ ref }) => ref),
      result.window,
    );
    await verifyArtifacts(snapshot.directory, snapshot.model.base, ({ path, sha256 }, bytes) => {
      if (path.endsWith(".json")) absences.inspect(JSON.parse(bytes.toString("utf8")), sha256);
    });
    const absenceEvidence = absences.result();
    const fullCalendarCoverage = absences.coverage();
    const receipt = {
      snapshotHash: snapshot.hash,
      reportSha256: hash,
      ...result,
      absenceEvidence,
      fullCalendarCoverage,
    };
    const name = `booking-report-offline-${fingerprint(receipt)}.json`;
    await privateWriteVerified(resolve(input.directory, name), JSON.stringify(receipt, null, 2));

    const atOrAfterReport = (at: string) =>
      Temporal.Instant.compare(at, result.reportGeneratedAt) >= 0;
    console.log(
      JSON.stringify(
        {
          receipt: name,
          window: result.window,
          pagesInspected: result.pagesInspected,
          allReportPagesInspected: result.allReportPagesInspected,
          calendarObservation: result.calendarObservation,
          archiveArtifactsVerified: snapshot.model.base.artifacts.length,
          rows: result.rows,
          distinctReferences: result.distinctReferences,
          repeatedRows: result.repeatedRows,
          archivedInWindow: result.archivedInWindow,
          matching: result.matching.length,
          changed: result.changed.length,
          contradictoryRows: result.contradictoryRows.length,
          ambiguousMinutes: result.ambiguousMinutes.length,
          reportOnlyConfirmed: result.reportOnlyConfirmed.length,
          reportOnlyConfirmedCorroborated: result.reportOnlyConfirmed.filter(
            (row) => row.corroboratedByCalendar,
          ).length,
          reportOnlyCancelled: result.reportOnlyCancelled.length,
          archivedNotInInspectedRows: result.archivedNotInInspectedRows.length,
          fullCalendarCoverage: {
            days: fullCalendarCoverage.length,
            observedDays: fullCalendarCoverage.filter((day) => day.lastFullObservation).length,
            observedDaysAtOrAfterReport: fullCalendarCoverage.filter(
              (day) => day.lastFullObservation && atOrAfterReport(day.lastFullObservation.at),
            ).length,
          },
          missingWithStoredCalendarPresence: absenceEvidence.filter((row) => row.presence).length,
          missingWithCalendarPresenceAtOrAfterReport: absenceEvidence.filter(
            (row) => row.presence && atOrAfterReport(row.presence.at),
          ).length,
          missingVisibleInReportCalendarObservation: result.archivedNotInInspectedRows.filter(
            (row) => row.visibleInCalendarObservation,
          ).length,
          lastAppointmentProven: result.lastAppointmentProven,
          canCutOver: result.canCutOver,
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Offline booking report reconciliation failed. Verify the private files, their hashes and the captured report scope.",
    );
    process.exitCode = 1;
  }
}
