import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { connectToNamedDatabase, createDb, dbOptionsFromEnv } from "./client";

test("named connections reject an override before opening the socket", async () => {
  const source = fileURLToPath(new URL("./client.ts", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "const { connectToNamedDatabase } = await import(process.argv[1]); await connectToNamedDatabase('postgres://127.0.0.1:1/intended');",
      source,
    ],
    {
      env: { ...process.env, PGDATABASE: "another_database" },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(5000),
    },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(error).toContain("The selected PostgreSQL database differs from the connection URL");
});

test("named connections require an explicit database in the URL", async () => {
  await expect(connectToNamedDatabase("postgres://127.0.0.1:1")).rejects.toThrow(
    "An explicit PostgreSQL database name is required",
  );
});

test.each(["host=127.0.0.2", "port=2", "socket=/tmp/citame-named-db-test"])(
  "named connections reject endpoint overrides (%s) before connecting",
  async (query) => {
    await expect(
      connectToNamedDatabase(`postgres://127.0.0.1:1/intended?${query}`),
    ).rejects.toThrow("The selected PostgreSQL endpoint differs from the connection URL");
  },
);

describe("createDb session limits", () => {
  test("applies statement, lock and idle-in-transaction timeouts to every connection", async () => {
    const { db, close } = createDb(undefined, {
      statementTimeoutMs: 1500,
      lockTimeoutMs: 2500,
      idleInTransactionTimeoutMs: 31_000,
      poolMax: 2,
    });
    try {
      const [row] = await db.execute<{ s: string; l: string; i: string }>(
        sql`select current_setting('statement_timeout') s, current_setting('lock_timeout') l, current_setting('idle_in_transaction_session_timeout') i`,
      );
      expect(row).toEqual({ s: "1500ms", l: "2500ms", i: "31s" });
      await expect(Promise.resolve(db.execute(sql`select pg_sleep(5)`))).rejects.toThrow(
        /Failed query/,
      );
    } finally {
      await close();
    }
  });

  test("defaults are 10 s / 5 s / 30 s and pool 10; 0 disables a timeout", () => {
    expect(dbOptionsFromEnv({})).toEqual({
      poolMax: 10,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 30_000,
    });
    expect(
      dbOptionsFromEnv({
        DB_POOL_MAX: "4",
        DB_STATEMENT_TIMEOUT_MS: "0",
        DB_LOCK_TIMEOUT_MS: "100",
      }),
    ).toMatchObject({ poolMax: 4, statementTimeoutMs: 0, lockTimeoutMs: 100 });
    expect(() => dbOptionsFromEnv({ DB_POOL_MAX: "x" })).toThrow(/DB_POOL_MAX/);
  });
});
