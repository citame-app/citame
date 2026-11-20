import { resolve } from "node:path";
import { collectBookingAbsences } from "../modules/booksy-transfer/absence-evidence";
import { compareBooksySnapshots, compareBooksyWaitlists } from "../modules/booksy-transfer/delta";
import { fingerprint } from "../modules/booksy-transfer/plan";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";
import { projectBooksyWaitlist } from "../modules/booksy-transfer/waitlist";

async function readEvidence(
  { model, directory }: Awaited<ReturnType<typeof readPrivateBooksySnapshot>>,
  absences: ReturnType<typeof collectBookingAbsences>,
) {
  const waiting: { sha256: string; payload: Buffer }[] = [];
  await verifyArtifacts(directory, model.base, ({ path, sha256 }, payload) => {
    if (!path.endsWith(".json")) return;
    const doc: unknown = JSON.parse(payload.toString("utf8"));
    absences.inspect(doc, sha256);
    if (
      doc &&
      typeof doc === "object" &&
      "source" in doc &&
      typeof doc.source === "string" &&
      doc.source.includes("/waitlist/")
    )
      waiting.push({ sha256, payload });
  });
  return projectBooksyWaitlist(waiting, model);
}

if (import.meta.main) {
  try {
    const [previousPath, currentPath, ...extra] = Bun.argv.slice(2);
    if (!previousPath || !currentPath || extra.length)
      throw new Error("Expected the previous and current private snapshot paths");
    const previous = await readPrivateBooksySnapshot(previousPath);
    const current = await readPrivateBooksySnapshot(currentPath);
    const changes = compareBooksySnapshots(previous.model, current.model);
    const absences = collectBookingAbsences(
      previous.model,
      current.model,
      changes.bookings.missingFromCurrentWindow,
    );
    const previousWaitlist = await readEvidence(previous, absences);
    const currentWaitlist = await readEvidence(current, absences);
    const delta = {
      ...changes,
      waitlist: compareBooksyWaitlists(previousWaitlist, currentWaitlist),
    };
    const receipt = {
      previous: previous.hash,
      current: current.hash,
      ...delta,
      bookingAbsenceEvidence: absences.result(),
    };
    const name = `source-delta-${fingerprint(receipt)}.json`;
    await privateWriteVerified(resolve(current.directory, name), JSON.stringify(receipt, null, 2));

    const { canCutOver, ...areas } = delta;
    console.log(
      JSON.stringify(
        {
          receipt: name,
          ...Object.fromEntries(
            Object.entries(areas).map(([area, details]) => [
              area,
              Object.fromEntries(
                Object.entries(details).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.length : value,
                ]),
              ),
            ]),
          ),
          canCutOver,
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Snapshot comparison failed. Check both private archives and their SHA-256 hashes.",
    );
    process.exitCode = 1;
  }
}
