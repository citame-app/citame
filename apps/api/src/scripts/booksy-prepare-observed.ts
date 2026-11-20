import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareObservedBooksy } from "../modules/booksy-transfer/observed";
import { fingerprint } from "../modules/booksy-transfer/plan";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { privateWriteVerified } from "../modules/booksy-transfer/vault";

if (import.meta.main) {
  try {
    const [directory, businessId, fromDate] = process.argv.slice(2);
    if (!directory || !businessId || !fromDate)
      throw new Error(
        "Usage: bun src/scripts/booksy-prepare-observed.ts <private archive> <business ID> <from YYYY-MM-DD>",
      );
    const root = await realpath(directory);
    const { input, summary } = await prepareObservedBooksy(root, businessId, fromDate);
    const bundlePath = resolve(root, `bundle-${fingerprint(input)}.json`);
    await privateWriteVerified(bundlePath, JSON.stringify(input, null, 2));
    const artifacts = [];
    for (const artifact of input.artifacts) {
      const value = JSON.parse(await readFile(resolve(root, artifact.path), "utf8"));
      artifacts.push({
        ...artifact,
        kind: typeof value.kind === "string" ? value.kind : "booksy-observation",
      });
    }
    const manifest: BooksyArchiveManifest = {
      version: 1,
      businessId,
      fromDate,
      timezone: "Europe/Madrid",
      complete: false,
      artifacts,
      limitations: [
        "UI capture is partial; the final appointment horizon is not proven",
        "Calendar references include booked services and blocks, not native reservations",
        "Canonical reservation/client references, complete annotations, archived staff and remaining center entities need an official complete export",
        "Unverified service configuration is preserved without native defaults",
        "No switch from Booksy, messages, payments or source modifications are authorized",
      ],
    };
    const manifestPath = resolve(root, `manifest-${fingerprint(manifest)}.json`);
    await privateWriteVerified(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(
      JSON.stringify(
        { bundlePath, manifestPath, summary, complete: false, canCutOver: false },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Capture preparation failed");
    process.exitCode = 1;
  }
}
