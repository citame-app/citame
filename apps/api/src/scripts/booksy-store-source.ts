import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import { fingerprint } from "../modules/booksy-transfer/plan";
import type { BooksySourceReadModel } from "../modules/booksy-transfer/source-read-model";
import { storeBooksySourceModel } from "../modules/booksy-transfer/source-store";
import { privateCliError, verifyArtifacts } from "../modules/booksy-transfer/vault";

if (import.meta.main)
  try {
    const [file, name, reviewHash] = process.argv.slice(2);
    const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
    if (
      !file ||
      !name ||
      !reviewHash ||
      !connection ||
      !/^sob_booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?$/.test(name)
    )
      throw new Error(
        "Expected a private source snapshot, explicit isolated database and exact snapshot hash",
      );
    const path = await realpath(file);
    const model = JSON.parse(await readFile(path, "utf8")) as BooksySourceReadModel;
    if (fingerprint(model) !== reviewHash)
      throw new Error("Source snapshot differs from the reviewed hash");
    await verifyArtifacts(dirname(path), model.base);
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1")
      throw new Error("Source copies require a loopback private connection");
    url.pathname = `/${name}`;
    const db = await connectToNamedDatabase(url.toString(), NO_DB_TIMEOUTS);
    try {
      console.log(JSON.stringify(await storeBooksySourceModel(db.db, model), null, 2));
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error(privateCliError(error, "Source storage failed"));
    process.exitCode = 1;
  }
