import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS, runMigrations } from "@sob/db";
import { planBooksyTransfer } from "../modules/booksy-transfer/plan";
import { applyBooksyRehearsal } from "../modules/booksy-transfer/rehearsal";
import { privateCliError, privateWrite, verifyArtifacts } from "../modules/booksy-transfer/vault";

/** Local-only CLI. It never contacts Booksy and has no cutover/delete/production mode. */
export async function booksyRehearsalCli(args: string[]) {
  const [command, file, ...options] = args;
  if (!["plan", "apply"].includes(command ?? "") || !file)
    throw new Error(
      "Usage: bun src/scripts/booksy-rehearsal.ts plan|apply <private bundle.json> [--database sob_booksy_rehearsal_YYYYMMDD --review <sha256>]",
    );
  const flags = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i],
      value = options[i + 1];
    if (!["--database", "--review"].includes(key ?? "") || !value || flags.has(key!))
      throw new Error("Invalid or duplicate option");
    flags.set(key!, value);
  }
  const path = await realpath(file);
  const info = await stat(path);
  if (info.size > 100_000_000) throw new Error("Bundle exceeds the 100 MB review limit");
  const raw = JSON.parse(await readFile(path, "utf8"));
  const plan = planBooksyTransfer(raw);
  await verifyArtifacts(dirname(path), plan.input);
  const reviewPath = resolve(dirname(path), `review-${plan.review.reviewHash}.json`);
  try {
    await privateWrite(reviewPath, JSON.stringify(plan.review, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(reviewPath, "utf8")) !== JSON.stringify(plan.review, null, 2))
      throw new Error("The saved review changed; preserve it and generate a new review", {
        cause: error,
      });
  }
  if (command === "plan") {
    console.log(
      JSON.stringify(
        {
          reviewHash: plan.review.reviewHash,
          counts: plan.review.counts,
          issues: plan.review.issues.length,
          blockers: plan.review.blockers.length,
          canRehearse: plan.review.canRehearse,
          canCutOver: false,
          reviewPath,
        },
        null,
        2,
      ),
    );
    return;
  }
  const name = flags.get("--database");
  if (!name || !/^sob_booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?$/.test(name))
    throw new Error("An explicitly named isolated rehearsal database is required");
  if (flags.get("--review") !== plan.review.reviewHash || !plan.review.canRehearse)
    throw new Error("Apply requires the exact valid reviewed hash");
  const connectionUrl = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
  if (!connectionUrl)
    throw new Error(
      "Use the private rehearsal connection file; the default Citame database is never used",
    );
  const url = new URL(connectionUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Remote database hosts are forbidden");
  url.pathname = `/${name}`;
  const connection = await connectToNamedDatabase(url.toString(), NO_DB_TIMEOUTS);
  try {
    await runMigrations(connection.db, { allowReviewDatabase: true });
    const result = await applyBooksyRehearsal(connection.db, raw, plan.review.reviewHash);
    console.log(
      JSON.stringify(
        {
          database: result.database,
          reviewHash: result.reviewHash,
          counts: result.counts,
          applied: result.applied,
          reconciled: result.reconciled,
          blockers: result.blockers.length,
          canCutOver: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await connection.close();
  }
}
if (import.meta.main) {
  try {
    await booksyRehearsalCli(process.argv.slice(2));
  } catch (error) {
    console.error(privateCliError(error, "Import failed"));
    process.exitCode = 1;
  }
}
