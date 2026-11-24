import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { booksyDesktopTestDatabase, connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
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
    const [hash, date, option, optionValue, billingContainer, ...extra] = process.argv.slice(2);
    const reviewBilling = option === "--billing-review";
    const preparedContainer = option === "--prepared-copy" ? optionValue : billingContainer;
    const preparedCopy = preparedContainer !== undefined;
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
    if (
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !date ||
      !connection ||
      extra.length ||
      (billingContainer !== undefined && !reviewBilling) ||
      (option !== undefined &&
        (!optionValue ||
          ![
            "--booking-links",
            "--price-review",
            "--price-review-all",
            "--prepared-copy",
            "--billing-review",
          ].includes(option)))
    ) {
      throw new Error("Expected the private connection file, snapshot hash and a calendar date");
    }
    const directory =
      optionValue && (option === "--booking-links" || reviewBilling)
        ? await realpath(optionValue)
        : undefined;
    if (directory) {
      const info = await stat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error("Expected an operator-owned private booking links directory");
    }
    const url = new URL(connection);
    const candidate = /^\/sob_booksy_candidate_(\d{8})_\d+$/.exec(url.pathname);
    const database = url.pathname.slice(1);
    if (
      url.hostname !== "127.0.0.1" ||
      url.username !== "citame_import" ||
      !(preparedCopy ? booksyDesktopTestDatabase.test(database) : candidate) ||
      url.search ||
      url.hash
    ) {
      throw new Error("Expected an isolated local Booksy copy");
    }
    const container = preparedContainer ?? (candidate && `citame-booksy-rehearsal-${candidate[1]}`);
    if (!container || !/^citame-booksy-rehearsal-\d{8}$/.test(container))
      throw new Error("Expected the private rehearsal container");
    await checkContainer(url, container);
    const priceScope =
      option === "--price-review-all" ? "all" : option === "--price-review" ? "day" : undefined;
    const snapshot =
      priceScope && optionValue ? await readPrivateBooksySnapshot(optionValue) : null;
    if (snapshot && snapshot.hash !== hash) throw new Error("Price review snapshot differs");
    const { db, close } = await connectToNamedDatabase(url.toString(), NO_DB_TIMEOUTS);
    try {
      const { bookingLinks, priceHolds, billingReview, ...report } = await inspectNativeBooksy(
        db,
        hash,
        date,
        {
          bookingLinks: option === "--booking-links",
          priceHolds: priceScope,
          preparedCopy,
          billingReview: reviewBilling,
        },
      );
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
      let billingReviewReceipt: string | undefined;
      if (directory && billingReview) {
        const receipt = {
          snapshotHash: hash,
          database,
          ...billingReview,
          canCutOver: false,
        };
        billingReviewReceipt = `native-billing-review-${fingerprint(receipt)}.json`;
        await privateWriteVerified(
          join(directory, billingReviewReceipt),
          JSON.stringify(receipt, null, 2),
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
      console.log(
        JSON.stringify(
          {
            ...report,
            priceReviewReceipt,
            priceReviewServices,
            billingReviewReceipt,
            billingReviewPending: billingReview?.pendingAppointments,
          },
          null,
          2,
        ),
      );
    } finally {
      await close();
    }
  } catch {
    // Database and parser errors can include original notes, references or connection information.
    console.error(
      "Booksy reconciliation failed. Check the isolated copy, snapshot, date and any private option argument.",
    );
    process.exitCode = 1;
  }
}
