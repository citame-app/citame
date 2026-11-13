import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/** Local compose credentials (see compose.yaml); real deployments set DATABASE_URL. */
export const DEFAULT_DATABASE_URL = "postgres://sob:sob@localhost:5432/sob";

export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = new SQL(url);
  const db = drizzle({ client, schema, casing: "snake_case" });
  return { db, client, close: () => client.close() };
}

export type Database = ReturnType<typeof createDb>["db"];
