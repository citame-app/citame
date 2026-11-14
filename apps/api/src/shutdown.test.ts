import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { TEST_SECRET } from "../test/helpers";

/**
 * Runs the real entrypoint as a child process and sends it SIGTERM: the only honest way to
 * verify graceful shutdown (readiness flips first, in-flight work drains, exit code 0).
 */
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase("shutdown");
});
afterAll(async () => {
  await db.close();
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("graceful shutdown of the API process", () => {
  test("SIGTERM flips /ready to draining, keeps /health alive, then exits 0 after closing everything", async () => {
    const port = await freePort();
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: db.url,
        VALKEY_KEY_PREFIX: `sob-test:shutdown:${Bun.randomUUIDv7()}:`,
        BETTER_AUTH_SECRET: TEST_SECRET,
        BETTER_AUTH_URL: `http://localhost:${port}`,
        SHUTDOWN_GRACE_MS: "1500",
        LOG_LEVEL: "info",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const base = `http://127.0.0.1:${port}`;
    try {
      await until(async () => (await fetch(`${base}/ready`)).status === 200, 20_000, "readiness");

      const started = Date.now();
      proc.kill("SIGTERM");
      await until(async () => (await fetch(`${base}/ready`)).status === 503, 1_000, "draining");
      const draining = (await (await fetch(`${base}/ready`)).json()) as { status: string };
      expect(draining.status).toBe("draining");
      // Liveness stays green while draining: the orchestrator must not kill the process early.
      expect((await fetch(`${base}/health`)).status).toBe(200);

      const code = await Promise.race([
        proc.exited,
        Bun.sleep(15_000).then(() => "timeout" as const),
      ]);
      expect(code).toBe(0);
      // The grace period was honoured before the listener went away.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
      const log = await stdout;
      expect(log).toContain('"msg":"shutdown requested"');
      expect(log).toContain('"msg":"shutdown complete"');
      await expect(fetch(`${base}/health`)).rejects.toThrow();
    } finally {
      proc.kill("SIGKILL");
    }
  }, 40_000);
});
