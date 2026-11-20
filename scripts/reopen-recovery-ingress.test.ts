import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reopenRecoveryIngress } from "./reopen-recovery-ingress";

const container = "a".repeat(64);
const origin = "https://example.test";

const storageReady = async () => {};

function fixture(state = "exited") {
  const calls: string[] = [];
  const compose = async (...args: string[]) => {
    calls.push(args[0] === "exec" ? `${args[2]} probe` : "resolve Caddy");
    return args[0] === "ps" ? container : "";
  };
  let publicLog = "";
  const docker = async (action: string, ...args: string[]) => {
    expect(args.at(-1)).toBe(container);
    calls.push(action);
    if (action === "inspect") return state;
    if (action === "logs") return publicLog;
    return "";
  };
  const recordReady = (options: RequestInit) => {
    const header = new Headers(options.headers).get("X-Citame-Recovery-Probe");
    publicLog = JSON.stringify({
      status: 200,
      request: { uri: "/api/ready", headers: { "X-Citame-Recovery-Probe": [header] } },
    });
  };
  return { calls, compose, docker, recordReady };
}

test("recovery opens the selected Caddy after private readiness and verifies a matching public request", async () => {
  const { calls, compose, docker, recordReady } = fixture();
  let attempts = 0;
  await reopenRecoveryIngress(
    origin,
    compose,
    docker,
    storageReady,
    async (_, options) => {
      calls.push("public probe");
      if (++attempts === 1) return Response.json({ status: "draining" }, { status: 503 });
      recordReady(options);
      return Response.json({ status: "ready" });
    },
    1_000,
  );
  expect(calls).toEqual([
    "resolve Caddy",
    "web probe",
    "worker probe",
    "inspect",
    "start",
    "public probe",
    "public probe",
    "logs",
    "worker probe",
  ]);
});

test("readiness from an unrelated proxy stops only the Caddy container started by recovery", async () => {
  const { calls, compose, docker } = fixture();
  await expect(
    reopenRecoveryIngress(
      origin,
      compose,
      docker,
      storageReady,
      async () => Response.json({ status: "ready" }),
      20,
    ),
  ).rejects.toThrow("Public API readiness could not be verified");
  expect(calls.slice(0, 6)).toEqual([
    "resolve Caddy",
    "web probe",
    "worker probe",
    "inspect",
    "start",
    "logs",
  ]);
  expect(calls.at(-1)).toBe("stop");
});

test("an earlier response from the selected proxy cannot authenticate a later attempt", async () => {
  const { calls, compose, docker, recordReady } = fixture();
  let attempts = 0;
  await expect(
    reopenRecoveryIngress(
      origin,
      compose,
      docker,
      storageReady,
      async (_, options) => {
        if (++attempts === 1) {
          recordReady(options);
          return new Response("Incomplete response");
        }
        return Response.json({ status: "ready" });
      },
      350,
    ),
  ).rejects.toThrow("Public API readiness could not be verified");
  expect(attempts).toBeGreaterThan(1);
  expect(calls.at(-1)).toBe("stop");
});

test("paused, restarting and running Caddy are left alone", async () => {
  for (const state of ["paused", "restarting", "running"]) {
    const { calls, compose, docker } = fixture(state);
    await expect(reopenRecoveryIngress(origin, compose, docker, storageReady)).rejects.toThrow(
      "Caddy must be stopped",
    );
    expect(calls).toEqual(["resolve Caddy", "web probe", "worker probe", "inspect"]);
  }
});

test("recovery requires the restored worker before opening ingress and again before success", async () => {
  for (const failure of [1, 2]) {
    const { calls, compose, docker, recordReady } = fixture();
    let workerProbes = 0;
    await expect(
      reopenRecoveryIngress(
        origin,
        async (...args) => {
          if (args[2] === "worker" && ++workerProbes === failure) {
            throw new Error("Restored worker is unavailable");
          }
          return compose(...args);
        },
        docker,
        storageReady,
        async (_, options) => {
          recordReady(options);
          return Response.json({ status: "ready" });
        },
        1_000,
      ),
    ).rejects.toThrow("Restored worker is unavailable");
    expect(calls.includes("start")).toBe(failure === 2);
    expect(calls.includes("stop")).toBe(failure === 2);
  }
});

test("interruption during the public probe closes the Caddy it started and releases the lock", async () => {
  const { calls, compose, docker } = fixture();
  const interruption = new AbortController();
  const reason = new Error("Recovery interrupted by test");
  await expect(
    reopenRecoveryIngress(
      origin,
      compose,
      docker,
      storageReady,
      async (_, options) => {
        interruption.abort(reason);
        options.signal?.throwIfAborted();
        return Response.json({ status: "ready" });
      },
      1_000,
      interruption.signal,
    ),
  ).rejects.toBe(reason);
  expect(calls.at(-1)).toBe("stop");
  const retry = fixture();
  await reopenRecoveryIngress(
    origin,
    retry.compose,
    retry.docker,
    storageReady,
    async (_, options) => {
      retry.recordReady(options);
      return Response.json({ status: "ready" });
    },
    1_000,
  );
});

test("a failed start that reached Docker still closes the selected Caddy", async () => {
  const { calls, compose, docker } = fixture();
  let attempted = false;
  await expect(
    reopenRecoveryIngress(
      origin,
      compose,
      async (action, ...args) => {
        if (action === "start") {
          attempted = true;
          throw new Error("Lost start response");
        }
        if (action === "inspect" && attempted) return "running";
        return docker(action, ...args);
      },
      storageReady,
    ),
  ).rejects.toThrow("Lost start response");
  expect(calls.at(-1)).toBe("stop");
});

test("a concurrent reopen cannot start or stop Caddy", async () => {
  const first = fixture();
  const second = fixture();
  const probing = Promise.withResolvers<void>();
  const releaseProbe = Promise.withResolvers<void>();
  const firstRun = reopenRecoveryIngress(
    origin,
    first.compose,
    first.docker,
    storageReady,
    async (_, options) => {
      probing.resolve();
      await releaseProbe.promise;
      first.recordReady(options);
      return Response.json({ status: "ready" });
    },
    1_000,
  );
  await probing.promise;
  try {
    await expect(
      reopenRecoveryIngress(origin, second.compose, second.docker, storageReady),
    ).rejects.toThrow("Recovery ingress is already being checked");
    expect(second.calls).toEqual(["resolve Caddy"]);
  } finally {
    releaseProbe.resolve();
    await firstRun;
  }
});

test("a failed private check leaves Caddy alone and a failed start triggers rollback", async () => {
  for (const failAt of ["exec", "start"]) {
    const { calls, compose, docker } = fixture();
    const checkedCompose = async (...args: string[]) => {
      if (args[0] === failAt) throw new Error("Compose private check failed");
      return compose(...args);
    };
    const checkedDocker = async (...args: string[]) => {
      if (args[0] === failAt) throw new Error("Docker start failed");
      return docker(args[0] ?? "", ...args.slice(1));
    };
    await expect(
      reopenRecoveryIngress(origin, checkedCompose, checkedDocker, storageReady),
    ).rejects.toThrow("failed");
    expect(calls.includes("stop")).toBe(failAt === "start");
  }
});

test("a storage mismatch leaves ingress closed or rolls back an in-progress opening", async () => {
  for (const failure of [1, 2]) {
    const { calls, compose, docker, recordReady } = fixture();
    let storageChecks = 0;
    await expect(
      reopenRecoveryIngress(
        origin,
        compose,
        docker,
        async () => {
          if (++storageChecks === failure) throw new Error("Recovery storage mismatch");
        },
        async (_, options) => {
          recordReady(options);
          return Response.json({ status: "ready" });
        },
      ),
    ).rejects.toThrow("Recovery storage mismatch");
    expect(calls.includes("start")).toBe(failure === 2);
    expect(calls.includes("stop")).toBe(failure === 2);
  }
});

test.each([
  ["signal", "SIGTERM cancels a hung Docker log command and closes Caddy"],
  ["worker", "a worker on the source database leaves Caddy stopped"],
  ["upstream", "a web upstream outside the restored project leaves Caddy stopped"],
] as const)(
  "%s — %s",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "citame-recovery-signal-"));
    const calls = join(directory, "calls");
    const caddyId = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const publicServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ready" }),
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(calls, "");
      const environment = {
        DATABASE_URL: "postgres://sob@postgres:5432/sob_recovered",
        VALKEY_URL: "redis://valkey:6379",
        VALKEY_KEY_PREFIX: "recovered:",
        SYNC_REPLICA_GENERATION: "recovered",
      };
      const web = { API_INTERNAL_URL: "http://api:3000" };
      const envEntries = (env: Record<string, string>) =>
        JSON.stringify(Object.entries(env).map(([key, value]) => `${key}=${value}`));
      await writeFile(
        join(directory, "docker"),
        `#!/bin/sh
case "$1" in
  compose)
    case " $* " in
      *" config --format json "*) printf '%s\\n' "$RENDERED_STORAGE" ;;
      *" ps "*" caddy "*) printf '%s\\n' "$CADDY_ID" ;;
      *" ps "*" api "*) printf 'synthetic-api\\n' ;;
      *" ps "*" worker "*) printf 'synthetic-worker\\n' ;;
      *" ps "*" web "*) printf 'synthetic-web\\n' ;;
    esac ;;
  inspect)
    if [ "$3" = '{{json .Config.Env}}' ]; then
      case "$4" in
        synthetic-worker) printf '%s\\n' "$WORKER_STORAGE" ;;
        synthetic-web) printf '%s\\n' "$WEB_STORAGE" ;;
        *) printf '%s\\n' "$RUNNING_STORAGE" ;;
      esac
    else
      printf 'exited\\n'
    fi ;;
  start|stop|logs)
    printf '%s\\n' "$1" >> "$DOCKER_CALLS"
    if [ "$1" = logs ]; then exec sleep 30; fi ;;
esac
`,
        { mode: 0o700 },
      );
      child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          fileURLToPath(new URL("./reopen-recovery-ingress.ts", import.meta.url)),
          publicServer.url.origin,
        ],
        {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            CADDY_ID: caddyId,
            DOCKER_CALLS: calls,
            RENDERED_STORAGE: JSON.stringify({
              services: {
                api: { environment },
                worker: { environment },
                migrate: { environment },
                web: { environment: web },
              },
            }),
            RUNNING_STORAGE: envEntries(environment),
            WORKER_STORAGE: envEntries(
              failure === "worker"
                ? {
                    ...environment,
                    DATABASE_URL: "postgres://sob:private-fixture@postgres:5432/sob",
                  }
                : environment,
            ),
            WEB_STORAGE: envEntries(
              failure === "upstream"
                ? {
                    API_INTERNAL_URL: "http://previous-api:3000",
                  }
                : web,
            ),
          },
          stdout: "ignore",
          stderr: "pipe",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (failure !== "signal") {
        expect(await child.exited).toBe(1);
        const message = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
        expect(message).toContain(
          failure === "worker"
            ? "the database, cache namespace or sync generation differs"
            : "the web gateway does not use the selected Compose API service",
        );
        expect(message).not.toContain("private-fixture");
        expect(await Bun.file(calls).text()).toBe("");
        return;
      }
      const deadline = performance.now() + 5000;
      while (!(await Bun.file(calls).text()).includes("logs")) {
        if (performance.now() >= deadline) throw new Error("Docker log probe did not start");
        await Bun.sleep(20);
      }
      child.kill("SIGTERM");
      expect(await child.exited).toBe(1);
      expect(await Bun.file(calls).text()).toBe("start\nlogs\nstop\n");
      await expect(
        lstat(join(tmpdir(), `citame-recovery-ingress-${caddyId}.lock`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await publicServer.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  12_000,
);
