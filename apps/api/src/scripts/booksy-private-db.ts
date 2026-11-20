import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import {
  privateWrite,
  privateWriteVerified,
  readPrivateArchiveFile,
} from "../modules/booksy-transfer/vault";
import { checkContainer, privateBooksyContainerPort } from "./booksy-backup";

/** Rebind one existing private file after Docker changes the loopback port. */
export async function refreshPrivateBooksyConnection(file: string) {
  const { bytes, path, directory } = await readPrivateArchiveFile(file);
  const value = /^BOOKSY_REHEARSAL_DATABASE_URL=([^\s]+)\r?\n?$/.exec(bytes.toString("utf8"))?.[1];
  const url = value ? new URL(value) : null;
  const database = url?.pathname.slice(1) ?? "";
  const date =
    /^sob_booksy_candidate_(\d{8})_\d+$/.exec(database)?.[1] ??
    /^sob_booksy_rehearsal_(\d{8})(?:_run[1-9]\d*)?$/.exec(database)?.[1];
  if (
    !url ||
    !date ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "citame_import" ||
    !url.password ||
    !url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Expected a private connection to an isolated Booksy rehearsal or candidate");

  const container = `citame-booksy-rehearsal-${date}`;
  const port = await privateBooksyContainerPort(container);
  const changed = port !== url.port;
  url.port = port;
  const db = await connectToNamedDatabase(url.href, NO_DB_TIMEOUTS);
  await db.close();
  await checkContainer(url, container);
  const connectionFile = changed
    ? resolve(directory, `connection-${database}-port-${port}.env`)
    : path;
  if (changed)
    await privateWriteVerified(connectionFile, `BOOKSY_REHEARSAL_DATABASE_URL=${url.href}\n`);
  return { container, database, host: url.hostname, port: Number(port), connectionFile, changed };
}

/** Starts only a new, private rehearsal server. Existing Citame/Postgres services stay untouched. */
export async function preparePrivateBooksyDatabase(root: string, date: string) {
  if (!/^\d{8}$/.test(date)) throw new Error("Expected rehearsal date YYYYMMDD");
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const name = `citame-booksy-rehearsal-${date}`;
  const volume = `citame-booksy-rehearsal-${date}`;
  const database = `sob_booksy_rehearsal_${date}`;
  const run = async (args: string[], allowFailure = false) => {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [status, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    if (status && !allowFailure)
      throw new Error(`Local database operation failed: ${args[1] ?? "docker"}`);
    return { status, out: out.trim() };
  };
  const existing = await run(["docker", "inspect", "--type", "container", name], true);
  let created = false;
  if (existing.status === 0) {
    const info = JSON.parse(existing.out)[0];
    if (info.Config?.Labels?.["citame.purpose"] !== "booksy-rehearsal")
      throw new Error("A container with this name belongs to another task");
    if (!info.State?.Running)
      throw new Error("Existing rehearsal is stopped; inspect it before starting it");
  } else {
    const image = await run(["docker", "image", "inspect", "postgres:18-alpine"], true);
    if (image.status)
      throw new Error("Official postgres:18-alpine image must already be installed");
    const password = randomBytes(32).toString("hex");
    await privateWrite(
      resolve(root, "postgres.env"),
      `POSTGRES_USER=citame_import\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${database}\n`,
    );
    await run([
      "docker",
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "citame.purpose=booksy-rehearsal",
      "--restart",
      "unless-stopped",
      "--env-file",
      resolve(root, "postgres.env"),
      "--publish",
      "127.0.0.1::5432",
      "--mount",
      `type=volume,src=${volume},dst=/var/lib/postgresql`,
      "postgres:18-alpine",
    ]);
    created = true;
  }
  const port = await privateBooksyContainerPort(name);
  const env = await readFile(resolve(root, "postgres.env"), "utf8");
  const password = /^POSTGRES_PASSWORD=([a-f0-9]+)$/m.exec(env)?.[1];
  if (!password) throw new Error("Private database credential file is unavailable");
  const connection = `BOOKSY_REHEARSAL_DATABASE_URL=postgres://citame_import:${password}@127.0.0.1:${port}/${database}\n`;
  const path = resolve(root, "connection.env");
  try {
    await privateWrite(path, connection);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== connection)
      throw new Error(
        "Existing connection settings differ. Use --refresh-connection if the local port changed",
        {
          cause: error,
        },
      );
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      !(
        await run(
          ["docker", "exec", name, "pg_isready", "-U", "citame_import", "-d", database],
          true,
        )
      ).status
    )
      return {
        container: name,
        volume,
        database,
        host: "127.0.0.1",
        port: Number(port),
        connectionFile: path,
        created,
      };
    await Bun.sleep(1000);
  }
  throw new Error("Private rehearsal database did not become ready");
}
if (import.meta.main) {
  try {
    const [root, date, ...extra] = process.argv.slice(2);
    if (!root || !date || extra.length)
      throw new Error(
        "Usage: booksy-private-db.ts <private archive directory> YYYYMMDD or --refresh-connection <private env file>",
      );
    if (root === "--refresh-connection") {
      try {
        console.log(JSON.stringify(await refreshPrivateBooksyConnection(date), null, 2));
      } catch {
        throw new Error(
          "Private connection refresh failed. Check the input file, rehearsal container and database.",
        );
      }
    } else {
      console.log(JSON.stringify(await preparePrivateBooksyDatabase(root, date), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Private database setup failed");
    process.exitCode = 1;
  }
}
