import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/** Local compose credentials (see compose.yaml); real deployments set DATABASE_URL. */
export const DEFAULT_DATABASE_URL = "postgres://sob:sob@localhost:5432/sob";

export interface DbOptions {
  /** Connections in the pool. */
  poolMax: number;
  /** Server-side cap per statement; 0 disables. */
  statementTimeoutMs: number;
  /** How long a statement waits for a lock (advisory locks included); 0 disables. */
  lockTimeoutMs: number;
  /** Kills sessions that sit idle inside an open transaction; 0 disables. */
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_DB_OPTIONS: DbOptions = {
  poolMax: 10,
  statementTimeoutMs: 10_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 30_000,
};

function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/** `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`. */
export function dbOptionsFromEnv(env: Record<string, string | undefined> = process.env): DbOptions {
  return {
    poolMax: envInt(env, "DB_POOL_MAX", DEFAULT_DB_OPTIONS.poolMax, 1),
    statementTimeoutMs: envInt(
      env,
      "DB_STATEMENT_TIMEOUT_MS",
      DEFAULT_DB_OPTIONS.statementTimeoutMs,
      0,
    ),
    lockTimeoutMs: envInt(env, "DB_LOCK_TIMEOUT_MS", DEFAULT_DB_OPTIONS.lockTimeoutMs, 0),
    idleInTransactionTimeoutMs: envInt(
      env,
      "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
      DEFAULT_DB_OPTIONS.idleInTransactionTimeoutMs,
      0,
    ),
  };
}

/**
 * Pool plus per-connection session limits, so one runaway query or a stuck transaction cannot
 * hold the pool hostage. Migrations and one-off maintenance scripts pass `NO_DB_TIMEOUTS`.
 */
export function createDb(
  url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  options: DbOptions = dbOptionsFromEnv(),
) {
  const client = new SQL(url, {
    max: options.poolMax,
    connection: {
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs,
    },
  });
  const db = drizzle({ client, schema, casing: "snake_case" });
  return { db, client, close: () => client.close() };
}

/** For migrations and long one-off jobs: no statement, lock or idle-transaction limits. */
export const NO_DB_TIMEOUTS: DbOptions = {
  ...DEFAULT_DB_OPTIONS,
  statementTimeoutMs: 0,
  lockTimeoutMs: 0,
  idleInTransactionTimeoutMs: 0,
};

export type Database = ReturnType<typeof createDb>["db"];
