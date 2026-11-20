import { createDb, DEFAULT_DATABASE_URL, NO_DB_TIMEOUTS } from "../client";
import { runMigrations } from "../migrate";
import { assertNotBooksyReviewDatabase } from "../operational-database";

const options = Bun.argv.slice(2);
const online = options.length === 1 && options[0] === "--online";
if (options.length && !online) throw new Error("Usage: migrate.ts [--online]");

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
assertNotBooksyReviewDatabase(url);
const { db, close } = createDb(url, NO_DB_TIMEOUTS);
try {
  await runMigrations(db, { online });
  console.log("Migrations applied.");
} finally {
  await close();
}
