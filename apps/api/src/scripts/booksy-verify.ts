import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToNamedDatabase } from "@sob/db";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { verifyBooksyRehearsal } from "../modules/booksy-transfer/verify";

if (import.meta.main) {
  try {
    const [file, name, bundle] = process.argv.slice(2);
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
    if (
      !file ||
      !name ||
      !bundle ||
      !connection ||
      !/^sob_booksy_(?:rehearsal_\d{8}(?:_run[1-9]\d*)?|restorecheck_\d{8}_\d+)$/.test(name)
    )
      throw new Error("Use a private connection file and an explicit rehearsal/restore database");
    const path = await realpath(file);
    const manifest = JSON.parse(await readFile(path, "utf8")) as BooksyArchiveManifest;
    const url = new URL(connection);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Remote database hosts are forbidden");
    url.pathname = `/${name}`;
    const db = await connectToNamedDatabase(url.toString());
    try {
      console.log(
        JSON.stringify(
          await verifyBooksyRehearsal(
            db.db,
            dirname(path),
            manifest,
            JSON.parse(await readFile(await realpath(bundle), "utf8")),
          ),
          null,
          2,
        ),
      );
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Verification failed");
    process.exitCode = 1;
  }
}
