import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import { inspectNativeBooksy } from "../modules/booksy-transfer/operational-rehearsal";
import { fingerprint } from "../modules/booksy-transfer/plan";
import {
  bindBooksyPriceReview,
  prepareBooksyPriceReview,
} from "../modules/booksy-transfer/price-review";
import {
  privateWriteVerified,
  readPrivateBooksySnapshot,
  verifyArtifacts,
} from "../modules/booksy-transfer/vault";
import { checkContainer } from "./booksy-backup";

if (import.meta.main) {
  try {
    const [hash, date, option, path, ...extra] = process.argv.slice(2);
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
    if (
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !date ||
      !connection ||
      extra.length ||
      (option !== undefined &&
        (!path || !["--booking-links", "--price-review", "--price-review-all"].includes(option)))
    ) {
      throw new Error("Expected the private connection file, snapshot hash and a calendar date");
    }
    const directory = option === "--booking-links" ? await realpath(path!) : undefined;
    if (directory) {
      const info = await stat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error("Expected an operator-owned private booking links directory");
    }
    const url = new URL(connection);
    const candidate = /^\/sob_booksy_candidate_(\d{8})_\d+$/.exec(url.pathname);
    if (
      url.hostname !== "127.0.0.1" ||
      url.username !== "citame_import" ||
      !candidate ||
      url.search ||
      url.hash
    ) {
      throw new Error("Expected an isolated local candidate");
    }
    await checkContainer(url, `citame-booksy-rehearsal-${candidate[1]}`);
    const priceScope =
      option === "--price-review-all" ? "all" : option === "--price-review" ? "day" : undefined;
    const snapshot = priceScope ? await readPrivateBooksySnapshot(path!) : null;
    if (snapshot && snapshot.hash !== hash) throw new Error("Price review snapshot differs");
    const { db, close } = await connectToNamedDatabase(url.toString(), NO_DB_TIMEOUTS);
    try {
      const { bookingLinks, priceHolds, ...report } = await inspectNativeBooksy(db, hash, date, {
        bookingLinks: !!directory,
        priceHolds: priceScope,
      });
      if (directory && bookingLinks) {
        await privateWriteVerified(
          join(directory, `native-booking-links-${hash}.json`),
          JSON.stringify(
            {
              snapshotHash: hash,
              database: url.pathname.slice(1),
              bookings: bookingLinks,
              canCutOver: false,
            },
            null,
            2,
          ),
        );
      }
      let priceReviewReceipt: string | undefined;
      let priceReviewServices: number | undefined;
      if (snapshot && priceHolds) {
        const review = prepareBooksyPriceReview(snapshot.model);
        await verifyArtifacts(snapshot.directory, snapshot.model.base, review.inspect);
        const receipt = {
          snapshotHash: hash,
          database: url.pathname.slice(1),
          archiveArtifactsVerified: snapshot.model.base.artifacts.length,
          ...bindBooksyPriceReview(
            snapshot.model,
            review.result(),
            priceScope === "all" ? undefined : date,
            priceHolds,
          ),
        };
        priceReviewServices = receipt.unresolvedServices;
        const scope = priceScope === "all" ? "all" : date;
        priceReviewReceipt = `native-price-review-${scope}-${fingerprint(receipt)}.json`;
        await privateWriteVerified(
          join(snapshot.directory, priceReviewReceipt),
          JSON.stringify(receipt, null, 2),
        );
      }
      console.log(JSON.stringify({ ...report, priceReviewReceipt, priceReviewServices }, null, 2));
    } finally {
      await close();
    }
  } catch {
    // Database and parser errors can include original notes, references or connection information.
    console.error(
      "Candidate report failed. Check the connection, snapshot, date and optional private input or output path.",
    );
    process.exitCode = 1;
  }
}
