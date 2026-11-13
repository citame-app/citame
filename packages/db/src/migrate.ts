import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Database } from "./client";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies pending drizzle-kit migrations (generated and hand-written) in journal order. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
