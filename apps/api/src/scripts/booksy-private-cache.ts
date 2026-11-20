import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { privateWrite } from "../modules/booksy-transfer/vault";

if (import.meta.main)
  try {
    const [directory, date] = process.argv.slice(2);
    if (!directory || !/^\d{8}$/.test(date ?? ""))
      throw new Error("Expected private directory and YYYYMMDD");
    const root = await realpath(directory),
      name = `citame-booksy-consultation-cache-${date}`;
    const run = async (args: string[], optional = false) => {
      const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, out] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      if (code && !optional) throw new Error("Private session cache operation failed");
      return { code, out: out.trim() };
    };
    const found = await run(["docker", "inspect", "--type", "container", name], true);
    const file = resolve(root, "cache.env");
    if (!found.code) {
      const d = JSON.parse(found.out)[0];
      if (d.Config?.Labels?.["citame.purpose"] !== "booksy-consultation" || !d.State?.Running)
        throw new Error("Existing cache is not an owned running consultation cache");
      await readFile(file);
      console.log(JSON.stringify({ container: name, connectionFile: file, created: false }));
    } else {
      if ((await run(["docker", "image", "inspect", "valkey/valkey:9.1-alpine"], true)).code)
        throw new Error("Official Valkey 9.1 image must already be installed");
      const password = randomBytes(32).toString("hex");
      await run([
        "docker",
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        "citame.purpose=booksy-consultation",
        "--restart",
        "unless-stopped",
        "--publish",
        "127.0.0.1::6379",
        "valkey/valkey:9.1-alpine",
        "valkey-server",
        "--appendonly",
        "no",
        "--save",
        "",
        "--requirepass",
        password,
      ]);
      const port = (await run(["docker", "port", name, "6379/tcp"])).out.match(
        /^127\.0\.0\.1:(\d+)$/,
      )?.[1];
      if (!port) throw new Error("Private session cache is not restricted to loopback");
      await privateWrite(file, `VALKEY_URL=redis://default:${password}@127.0.0.1:${port}\n`);
      console.log(
        JSON.stringify({
          container: name,
          connectionFile: file,
          host: "127.0.0.1",
          port: Number(port),
          created: true,
        }),
      );
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Private cache failed");
    process.exitCode = 1;
  }
