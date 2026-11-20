import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fingerprint, planBooksyTransfer } from "../modules/booksy-transfer/plan";
import {
  holdBooksyCombinations,
  reviewBooksyCombinations,
} from "../modules/booksy-transfer/source-combinations";
import {
  type BooksySourceReadModel,
  prepareBooksySourceReadModel,
} from "../modules/booksy-transfer/source-read-model";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { privateWriteVerified, verifyArtifacts } from "../modules/booksy-transfer/vault";

if (import.meta.main)
  try {
    const [directory, businessId, fromDate, mode, priorHash, ...extra] = process.argv.slice(2);
    if (
      !directory ||
      !businessId ||
      !fromDate ||
      extra.length ||
      (mode !== undefined && (mode !== "--hold-combos" || !/^[a-f0-9]{64}$/.test(priorHash ?? "")))
    )
      throw new Error(
        "Expected private archive, business ID and local start date, optionally --hold-combos SNAPSHOT_HASH",
      );
    const root = await realpath(directory);
    let model: BooksySourceReadModel;
    if (mode === "--hold-combos") {
      model = JSON.parse(
        await readFile(resolve(root, `source-snapshot-${priorHash}.json`), "utf8"),
      );
      if (
        fingerprint(model) !== priorHash ||
        model.businessId !== businessId ||
        model.fromDate !== fromDate
      )
        throw new Error("Previous snapshot differs from the specified source");
      await verifyArtifacts(root, model.base);
      model.base.services = holdBooksyCombinations(model.base.services);
    } else {
      model = await prepareBooksySourceReadModel(root, businessId, fromDate);
    }
    const plan = planBooksyTransfer(model.base);
    if (!plan.review.canRehearse)
      throw new Error(
        `Native preparation has ${plan.review.issues.length} unresolved validation issues`,
      );
    const hash = fingerprint(model);
    const snapshotPath = resolve(root, `source-snapshot-${hash}.json`);
    const bundlePath = resolve(root, `bundle-${plan.review.reviewHash}.json`);
    const manifest: BooksyArchiveManifest = {
      version: 1,
      businessId,
      fromDate,
      timezone: "Europe/Madrid",
      complete: false,
      artifacts: await Promise.all(
        model.base.artifacts.map(async (a) => ({
          ...a,
          kind: JSON.parse(await readFile(resolve(root, a.path), "utf8")).kind,
        })),
      ),
      limitations: [
        "Source appointments are an immutable consultation copy, retaining original overlaps and groups",
        "The globally final reservation is not proven",
        "Operational cutover and remaining center modules require separate reconciliation",
      ],
    };
    const manifestPath = resolve(root, `manifest-${fingerprint(manifest)}.json`);
    await privateWriteVerified(snapshotPath, JSON.stringify(model, null, 2));
    await privateWriteVerified(bundlePath, JSON.stringify(model.base, null, 2));
    await privateWriteVerified(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(
      JSON.stringify(
        {
          snapshotPath,
          bundlePath,
          manifestPath,
          snapshotHash: hash,
          reviewHash: plan.review.reviewHash,
          summary: model.summary,
          native: plan.review.counts,
          blockers: plan.review.blockers.length,
          catalogueCombinations: reviewBooksyCombinations(model.base.services),
          canCutOver: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preparation failed");
    process.exitCode = 1;
  }
