import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { jwks } from "@sob/db";
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
beforeEach(async () => {
  await db.reset();
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

function launchApi(port: number, secret = TEST_SECRET) {
  return Bun.spawn(["bun", "src/index.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: db.url,
      VALKEY_KEY_PREFIX: `sob-test:shutdown:${Bun.randomUUIDv7()}:`,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: `http://localhost:${port}`,
      SHUTDOWN_GRACE_MS: "1500",
      LOG_LEVEL: "info",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("startup refuses an incompatible restored signing key before opening its listener", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const original = launchApi(port);
  let restored: ReturnType<typeof launchApi> | undefined;
  try {
    await until(async () => (await fetch(`${base}/ready`)).status === 200, 20_000, "readiness");
    expect(await db.db.select({ id: jwks.id }).from(jwks)).toHaveLength(0);
    const published = await fetch(`${base}/api/auth/jwks`);
    expect(published.status).toBe(200);
    const keys = await db.db.select({ id: jwks.id }).from(jwks);
    expect(keys).toHaveLength(1);
    original.kill("SIGTERM");
    expect(await original.exited).toBe(0);

    restored = launchApi(port, "different-test-auth-secret-0123456789");
    const logs = Promise.all([
      new Response(restored.stdout).text(),
      new Response(restored.stderr).text(),
    ]);
    const result = await Promise.race([restored.exited, Bun.sleep(15_000).then(() => "timeout")]);
    expect(result).toBe(1);
    const [stdout] = await logs;
    expect(stdout).not.toContain('"msg":"api listening"');
    expect(stdout).toContain('"msg":"api startup checks failed"');
    expect(stdout).toContain("Cannot use the OAuth signing key.");
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    expect(await db.db.select({ id: jwks.id }).from(jwks)).toEqual(keys);
  } finally {
    original.kill("SIGKILL");
    restored?.kill("SIGKILL");
  }
}, 40_000);

describe("graceful shutdown of the API process", () => {
  test("SIGTERM flips /ready to draining, keeps /health alive, then exits 0 after closing everything", async () => {
    const port = await freePort();
    const proc = launchApi(port);
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
