import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { privateWrite } from "../modules/booksy-transfer/vault";

/** A new same-day run never overwrites, resets or drops an earlier rehearsal. */
if (import.meta.main)
  try {
    const [connectionFile, directory, run] = process.argv.slice(2);
    if (!connectionFile || !directory || !/^[1-9]\d{0,3}$/.test(run ?? ""))
      throw new Error(
        "Expected an existing private connection file, new private directory and positive run number",
      );
    const env = await readFile(await realpath(connectionFile), "utf8");
    const value = /^BOOKSY_REHEARSAL_DATABASE_URL=(.+)$/m.exec(env)?.[1];
    if (!value) throw new Error("Private connection is missing");
    const url = new URL(value),
      date = /^\/sob_booksy_rehearsal_(\d{8})(?:_run[1-9]\d*)?$/.exec(url.pathname)?.[1];
    if (!date || url.hostname !== "127.0.0.1" || url.username !== "citame_import")
      throw new Error("Expected an owned isolated loopback database");
    const container = `citame-booksy-rehearsal-${date}`;
    const inspect = Bun.spawn(["docker", "inspect", "--type", "container", container], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, out] = await Promise.all([inspect.exited, new Response(inspect.stdout).text()]);
    if (code) throw new Error("Owned rehearsal container is unavailable");
    const info = JSON.parse(out)[0],
      ports = info.NetworkSettings?.Ports?.["5432/tcp"];
    if (
      info.Config?.Labels?.["citame.purpose"] !== "booksy-rehearsal" ||
      !info.State?.Running ||
      ports?.length !== 1 ||
      ports[0].HostIp !== "127.0.0.1" ||
      ports[0].HostPort !== url.port
    )
      throw new Error("Container ownership or private binding differs");
    const name = `sob_booksy_rehearsal_${date}_run${run}`;
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const target = resolve(root, "connection.env");
    try {
      await readFile(target);
      throw new Error("Target connection file already exists; choose a new run directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const create = Bun.spawn(
      ["docker", "exec", container, "createdb", "-U", "citame_import", name],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (await create.exited)
      throw new Error(
        "New database could not be created; an existing run is never reused or removed",
      );
    url.pathname = `/${name}`;
    await privateWrite(target, `BOOKSY_REHEARSAL_DATABASE_URL=${url.href}\n`);
    console.log(
      JSON.stringify({ database: name, connectionFile: target, previousRunsPreserved: true }),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : "New isolated run failed");
    process.exitCode = 1;
  }
