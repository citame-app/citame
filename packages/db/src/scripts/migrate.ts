import { createDb, NO_DB_TIMEOUTS } from "../client";
import { runMigrations } from "../migrate";

const { db, close } = createDb(undefined, NO_DB_TIMEOUTS);
try {
  await runMigrations(db);
  console.log("Migrations applied.");
} finally {
  await close();
}
