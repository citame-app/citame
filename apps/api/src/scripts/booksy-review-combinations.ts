import { join } from "node:path";
import { fingerprint } from "../modules/booksy-transfer/plan";
import { sourceBooksyCombinationTerms } from "../modules/booksy-transfer/source-combinations";
import { prepareBooksySourceReadModel } from "../modules/booksy-transfer/source-read-model";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";

if (import.meta.main) {
  try {
    const [snapshotPath, ...extra] = Bun.argv.slice(2);
    if (!snapshotPath || extra.length) throw new Error("Expected the path to one private snapshot");
    const { hash, model, directory } = await readPrivateBooksySnapshot(snapshotPath);
    await verifyArtifacts(directory, model.base);
    const combinations = sourceBooksyCombinationTerms(model.base.services);
    const projected = await prepareBooksySourceReadModel(
      directory,
      model.businessId,
      model.fromDate,
    );
    const rebuilt = sourceBooksyCombinationTerms(projected.base.services);
    const sourceOnly = (rows: typeof combinations) => rows.map(({ active: _, ...row }) => row);
    if (fingerprint(sourceOnly(combinations)) !== fingerprint(sourceOnly(rebuilt)))
      throw new Error("Combination terms differ from the archived catalogue");
    const receipt = {
      snapshotHash: hash,
      archiveArtifactsVerified: model.base.artifacts.length,
      combinations,
      canCutOver: false,
    };
    const name = `combination-review-${fingerprint(receipt)}.json`;
    await privateWriteVerified(join(directory, name), JSON.stringify(receipt, null, 2));
    console.log(
      JSON.stringify(
        {
          receipt: name,
          archiveArtifactsVerified: receipt.archiveArtifactsVerified,
          combinations: combinations.length,
          verifiedTerms: combinations.filter(({ terms }) => terms != null).length,
          canCutOver: receipt.canCutOver,
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Offline combination review failed. Verify the private snapshot and its archive.",
    );
    process.exitCode = 1;
  }
}
