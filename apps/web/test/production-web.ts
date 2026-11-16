/** Disposable local web runtime for Playwright. Never imported by the production server. */
export {};

if (process.env.NODE_ENV !== "test")
  throw new Error("Production browser fixture requires NODE_ENV=test");
const name = "sob-citame-web-e2e";
const runId = crypto.randomUUID();
const args = [
  "run",
  "--pull=never",
  "--rm",
  "--name",
  name,
  "--label",
  "sob.citame.fixture=web-e2e",
  "--label",
  `sob.citame.run=${runId}`,
  "--network",
  "host",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,size=128m",
  "-e",
  "API_INTERNAL_URL=http://localhost:4300",
  "-e",
  "HOST=127.0.0.1",
  "-e",
  "PORT=4273",
  "-e",
  "PUBLIC_URL=http://localhost:4273",
];
if (process.env.E2E_ACQUISITION_FIXTURE === "true")
  args.push("-e", "BOOKING_WIDGET_ORIGINS=http://localhost:4274,http://127.0.0.1:4274");
args.push("sob-web:citame-e2e");
const runtime = Bun.spawn(["docker", ...args], { stdout: "inherit", stderr: "inherit" });
let stopping = false;
let cleanup: Promise<void> | undefined;
function stopOwnedContainer() {
  cleanup ??= (async () => {
    // The Docker CLI may already have died from a process-group signal. Inspect the
    // daemon and stop only the container labelled for this invocation, not another run.
    for (let attempt = 0; attempt < 5; attempt++) {
      const probe = Bun.spawn(
        ["docker", "inspect", name, "--format", '{{index .Config.Labels "sob.citame.run"}}'],
        { stdout: "pipe", stderr: "ignore" },
      );
      const [status, label] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
      if (status === 0) {
        if (label.trim() === runId)
          await Bun.spawn(["docker", "stop", "--time", "3", name], {
            stdout: "ignore",
            stderr: "inherit",
          }).exited;
        return;
      }
      await Bun.sleep(100);
    }
  })();
  return cleanup;
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    void stopOwnedContainer().finally(() => process.exit(0));
  });
const status = await runtime.exited;
await stopOwnedContainer();
process.exit(stopping ? 0 : status);
