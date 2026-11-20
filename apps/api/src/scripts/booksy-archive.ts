import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import { z } from "zod";
import { stageBooksyArchive } from "../modules/booksy-transfer/stage";
import { privateCliError } from "../modules/booksy-transfer/vault";

const manifestSchema = z.object({
  version: z.literal(1),
  businessId: z.string().min(1),
  fromDate: z.iso.date(),
  timezone: z.literal("Europe/Madrid"),
  complete: z.literal(false),
  artifacts: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      kind: z.string().min(1),
    }),
  ),
  limitations: z.array(z.string()),
});
if (import.meta.main) {
  try {
    const [file, name] = process.argv.slice(2);
    if (!file || !name || !/^sob_booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?$/.test(name))
      throw new Error(
        "Usage: bun src/scripts/booksy-archive.ts <private manifest.json> sob_booksy_rehearsal_YYYYMMDD",
      );
    const path = await realpath(file);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
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
      console.log(
        JSON.stringify(await stageBooksyArchive(connection.db, dirname(path), manifest), null, 2),
      );
    } finally {
      await connection.close();
    }
  } catch (error) {
    console.error(privateCliError(error, "Archive staging failed"));
    process.exitCode = 1;
  }
}
