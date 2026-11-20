import { resolve } from "node:path";
import { fingerprint } from "../modules/booksy-transfer/plan";
import { prepareBooksyPriceReview } from "../modules/booksy-transfer/price-review";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";

if (import.meta.main) {
  try {
    const [snapshotPath, ...extra] = Bun.argv.slice(2);
    if (!snapshotPath || extra.length) throw new Error("Expected the path to one private snapshot");
    const snapshot = await readPrivateBooksySnapshot(snapshotPath);
    const review = prepareBooksyPriceReview(snapshot.model);
    await verifyArtifacts(snapshot.directory, snapshot.model.base, review.inspect);
    const result = review.result();
    const receipt = {
      snapshotHash: snapshot.hash,
      archiveArtifactsVerified: snapshot.model.base.artifacts.length,
      ...result,
    };
    const name = `price-review-${fingerprint(receipt)}.json`;
    await privateWriteVerified(resolve(snapshot.directory, name), JSON.stringify(receipt, null, 2));
    console.log(
      JSON.stringify(
        {
          receipt: name,
          archiveArtifactsVerified: receipt.archiveArtifactsVerified,
          groups: result.groups.length,
          unresolvedServices: result.unresolvedServices,
          groupsMatchingVisibleTotal: result.groups.filter(
            (row) => row.comparison === "equals_visible_lines",
          ).length,
          visibleDiscountHolds: result.groups.filter(
            (row) => row.comparison === "discounted_screen",
          ).length,
          canCutOver: result.canCutOver,
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Offline price review failed. Verify the private snapshot and the original reservation files.",
    );
    process.exitCode = 1;
  }
}
