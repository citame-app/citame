import { rmdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Command = (...args: string[]) => Promise<string>;
type FetchReady = (url: URL, options: RequestInit) => Promise<Response>;
const publicReadinessTimeoutMs = 45_000;

const privateProbe = `
  if (URL.parse(process.env.PUBLIC_URL ?? "")?.origin !== Bun.argv[1]) {
    console.error("The public origin does not match the web container's PUBLIC_URL.");
    process.exit(1);
  }
  const res = await fetch("http://127.0.0.1:" + (process.env.PORT ?? 4173) + "/api/ready", {
    redirect: "error",
    signal: AbortSignal.timeout(3500),
  });
  const body = await res.json();
  process.exit(res.ok && body.status === "ready" ? 0 : 1);
`;

export async function reopenRecoveryIngress(
  publicOrigin: string,
  compose: Command,
  docker: Command,
  checkStorage: () => Promise<unknown>,
  fetchReady: FetchReady = fetch,
  timeoutMs = publicReadinessTimeoutMs,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const origin = URL.parse(publicOrigin);
  if (
    !origin ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Use the public HTTP or HTTPS origin without credentials, a path or a query");
  const container = (await compose("ps", "--all", "--quiet", "--no-trunc", "caddy")).trim();
  if (!/^[0-9a-f]{64}$/.test(container))
    throw new Error("Expected one existing Caddy container in the selected Compose project");
  const lock = join(tmpdir(), `citame-recovery-ingress-${container}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`Recovery ingress is already being checked. Lock directory: ${lock}`, {
        cause: error,
      });
    throw error;
  }
  try {
    await checkStorage();
    await compose("exec", "-T", "web", "bun", "-e", privateProbe, origin.origin);
    const checkWorker = () =>
      compose("exec", "-T", "worker", "bun", "apps/api/src/scripts/check-worker-ready.ts");
    await checkWorker();
    const state = (await docker("inspect", "--format", "{{.State.Status}}", container)).trim();
    if (state !== "created" && state !== "exited")
      throw new Error("Caddy must be stopped before a recovery switch");
    signal?.throwIfAborted();
    try {
      await docker("start", container);
      signal?.throwIfAborted();
      await verifyPublicReadiness(
        new URL("/api/ready", origin),
        container,
        docker,
        fetchReady,
        timeoutMs,
        signal,
      );
      signal?.throwIfAborted();
      await checkStorage();
      await checkWorker();
      signal?.throwIfAborted();
    } catch (error) {
      try {
        // Docker may have acted even if the start command lost its response.
        await docker("stop", container);
      } catch {
        throw new Error(
          "Failed to close Caddy after the recovery readiness check. Check ingress now.",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    rmdirSync(lock);
  }
}

async function verifyPublicReadiness(
  readyUrl: URL,
  container: string,
  docker: Command,
  fetchReady: FetchReady,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const probeHeader = "X-Citame-Recovery-Probe";
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const probe = crypto.randomUUID();
      const requestDeadline = AbortSignal.timeout(
        Math.max(1, Math.min(3000, Math.ceil(deadline - performance.now()))),
      );
      const response = await fetchReady(readyUrl, {
        headers: { [probeHeader]: probe },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, requestDeadline]) : requestDeadline,
      });
      const result = await response.json();
      if (
        response.ok &&
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "ready"
      ) {
        const logs = await docker("logs", "--tail", "500", container);
        if (
          logs.split("\n").some((line) => {
            try {
              const entry = JSON.parse(line);
              return (
                entry?.status === 200 &&
                entry.request?.uri === "/api/ready" &&
                entry.request?.headers?.[probeHeader]?.includes(probe)
              );
            } catch {
              return false;
            }
          })
        )
          return;
      }
    } catch {
      // Caddy, TLS or its upstream can still be starting.
      signal?.throwIfAborted();
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await Bun.sleep(Math.min(250, remaining));
  }
  signal?.throwIfAborted();
  throw new Error(
    "Public API readiness could not be verified through the selected Caddy container",
  );
}

if (import.meta.main) {
  const [publicOrigin, ...options] = Bun.argv.slice(2);
  if (!publicOrigin) {
    console.error(
      "Usage: bun --no-env-file scripts/reopen-recovery-ingress.ts <public-origin> [Compose global options]",
    );
    process.exit(1);
  }
  const cancellation = new AbortController();
  const run = async (commandLine: string[], action: string, dockerAction?: string) => {
    const changingState = dockerAction === "start" || dockerAction === "stop";
    const commandDeadline = AbortSignal.timeout(dockerAction === "stop" ? 25_000 : 12_000);
    const command = Bun.spawn(commandLine, {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: "ignore",
      stdout: "pipe",
      stderr: dockerAction === "logs" ? "ignore" : "inherit",
      signal: changingState
        ? commandDeadline
        : AbortSignal.any([cancellation.signal, commandDeadline]),
    });
    const [code, output] = await Promise.all([command.exited, new Response(command.stdout).text()]);
    if (code !== 0) {
      if (!changingState) cancellation.signal.throwIfAborted();
      throw new Error(`${action} failed during recovery ingress checks`);
    }
    return output;
  };
  const docker: Command = (...args) => run(["docker", ...args], `Docker ${args[0]}`, args[0]);
  const composeArgs = ["compose", "-f", "compose.prod.yaml", ...options, "--profile", "tls"];
  const compose: Command = (...args) => docker(...composeArgs, ...args);
  const checkStorage = () =>
    run(
      ["python3", "scripts/check-compose-storage.py", "recovery", "docker", ...composeArgs],
      "Storage verification",
    );
  const interrupt = () => cancellation.abort(new Error("Recovery ingress check interrupted"));
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  try {
    await reopenRecoveryIngress(
      publicOrigin,
      compose,
      docker,
      checkStorage,
      fetch,
      publicReadinessTimeoutMs,
      cancellation.signal,
    );
    console.log("Public API and notification worker are ready.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Recovery ingress check failed.");
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  }
}
