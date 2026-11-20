import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import { rehearseNativeBooksy } from "../modules/booksy-transfer/operational-rehearsal";

if (import.meta.main) {
  try {
    const [name, hash, flag, ...extra] = process.argv.slice(2);
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
    const candidate = flag === "--prepare";
    const target = candidate
      ? /^sob_booksy_candidate_\d{8}_\d+$/
      : /^sob_booksy_restorecheck_\d{8}_\d+$/;
    if (
      !name ||
      !target.test(name) ||
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !connection ||
      extra.length ||
      (flag !== undefined && !candidate)
    )
      throw new Error(
        "Expected a separate local database, snapshot hash and private connection file",
      );
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1" || url.username !== "citame_import")
      throw new Error("A private loopback Booksy database is required");
    url.pathname = `/${name}`;
    const db = await connectToNamedDatabase(url.href, NO_DB_TIMEOUTS);
    try {
      console.log(
        JSON.stringify(
          await rehearseNativeBooksy(db.db, hash, candidate ? "prepare" : "rollback"),
          null,
          2,
        ),
      );
    } finally {
      await db.close();
    }
  } catch (error) {
    // PostgreSQL errors may include values from private client notes or service data.
    const code =
      error instanceof Error && typeof error.cause === "object" && error.cause
        ? Reflect.get(error.cause, "errno")
        : undefined;
    console.error(
      typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
        ? `Native import check failed. PostgreSQL ${code}.`
        : "Native import check failed. Verify the isolated database before retrying.",
    );
    process.exitCode = 1;
  }
}
