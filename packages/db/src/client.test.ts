import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, dbOptionsFromEnv } from "./client";

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
      await expect(db.execute(sql`select pg_sleep(5)`)).rejects.toThrow(/Failed query/);
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
