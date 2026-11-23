import { resolve } from "node:path";
import { auditCalendarCoverage } from "../modules/booksy-transfer/calendar-coverage";
import { fingerprint } from "../modules/booksy-transfer/plan";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";
import { visibleBookingEnvelope } from "../modules/booksy-transfer/visible-booking-evidence";
import { verifyReviewedVisibleBooking } from "./booksy-review-visible-booking";

if (import.meta.main) {
  try {
    const [snapshotPath, from, to, atOrAfter, ...extra] = Bun.argv.slice(2);
    if (!snapshotPath || !from || !to || !atOrAfter || extra.length)
      throw new Error("Expected a snapshot path, local date range and capture cutoff");
    const { hash, model, directory } = await readPrivateBooksySnapshot(snapshotPath);
    const audit = auditCalendarCoverage(model, { from, to, atOrAfter });
    const visibleGroups = new Map(
      model.groups.flatMap((group) =>
        group.raw.kind === "booksy-reviewed-visible-booking" &&
        typeof group.raw.evidenceSha256 === "string"
          ? [[group.raw.evidenceSha256, group] as const]
          : [],
      ),
    );
    const visibleEvidence: {
      artifact: (typeof model.base.artifacts)[number];
      document: unknown;
    }[] = [];
    await verifyArtifacts(directory, model.base, (artifact, bytes) => {
      if (!artifact.path.endsWith(".json")) return;
      const document: unknown = JSON.parse(bytes.toString("utf8"));
      audit.inspect(document, artifact.sha256);
      if (visibleGroups.has(artifact.sha256)) visibleEvidence.push({ artifact, document });
    });
    const { days, lastObservedAppointmentAt, ...summary } = audit.result();
    const absent = new Set(days.flatMap((day) => day.reconciliation?.absent ?? []));
    const visuallyReviewed = new Map<string, ReturnType<typeof verifyReviewedVisibleBooking>>();
    for (const { artifact, document } of visibleEvidence) {
      const group = visibleGroups.get(artifact.sha256);
      if (typeof group?.raw.itemRef !== "string" || !absent.has(group.raw.itemRef)) continue;
      const envelope = visibleBookingEnvelope.parse(document);
      const parent = await readPrivateBooksySnapshot(
        resolve(directory, `source-snapshot-${envelope.parentHash}.json`),
      ).catch((error: unknown) => {
        // An exported snapshot can have the verified evidence bundle but omit its parent.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      });
      if (!parent) continue;
      const verified = verifyReviewedVisibleBooking(model, group, parent.model, envelope, artifact);
      visuallyReviewed.set(verified.itemRef, verified);
    }
    const absentLineEvidence = {
      reviewedVisible: visuallyReviewed.size,
      withoutReviewedVisible: absent.size - visuallyReviewed.size,
    };
    const archiveArtifactsVerified = model.base.artifacts.length;
    const receipt = {
      snapshotHash: hash,
      archiveArtifactsVerified,
      ...summary,
      lastObservedAppointmentAt,
      absentLineEvidence,
      days: days.map((day) => ({
        ...day,
        reviewedVisibleAbsences: (day.reconciliation?.absent ?? []).flatMap((itemRef) => {
          const evidence = visuallyReviewed.get(itemRef);
          return evidence ? [evidence] : [];
        }),
      })),
    };
    const name = `calendar-window-audit-${fingerprint(receipt)}.json`;
    await privateWriteVerified(resolve(directory, name), JSON.stringify(receipt, null, 2));
    console.log(
      JSON.stringify(
        { receipt: name, archiveArtifactsVerified, ...summary, absentLineEvidence },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Calendar audit failed. Check the private snapshot, its archive, the inclusive ISO dates and the cutoff with time zone.",
    );
    process.exitCode = 1;
  }
}
