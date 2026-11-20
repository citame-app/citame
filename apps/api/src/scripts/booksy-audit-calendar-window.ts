import { resolve } from "node:path";
import { auditCalendarCoverage } from "../modules/booksy-transfer/calendar-coverage";
import { fingerprint } from "../modules/booksy-transfer/plan";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";

if (import.meta.main) {
  try {
    const [snapshotPath, from, to, atOrAfter, ...extra] = Bun.argv.slice(2);
    if (!snapshotPath || !from || !to || !atOrAfter || extra.length)
      throw new Error("Expected a snapshot path, local date range and capture cutoff");
    const { hash, model, directory } = await readPrivateBooksySnapshot(snapshotPath);
    const audit = auditCalendarCoverage(model, { from, to, atOrAfter });
    await verifyArtifacts(directory, model.base, ({ path, sha256 }, bytes) => {
      if (path.endsWith(".json")) audit.inspect(JSON.parse(bytes.toString("utf8")), sha256);
    });
    const { days, lastObservedAppointmentAt, ...summary } = audit.result();
    const archiveArtifactsVerified = model.base.artifacts.length;
    const receipt = {
      snapshotHash: hash,
      archiveArtifactsVerified,
      ...summary,
      lastObservedAppointmentAt,
      days,
    };
    const name = `calendar-window-audit-${fingerprint(receipt)}.json`;
    await privateWriteVerified(resolve(directory, name), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ receipt: name, archiveArtifactsVerified, ...summary }, null, 2));
  } catch {
    console.error(
      "Calendar audit failed. Check the private snapshot, its archive, the inclusive ISO dates and the cutoff with time zone.",
    );
    process.exitCode = 1;
  }
}
