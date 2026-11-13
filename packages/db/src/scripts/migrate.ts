import { createDb } from "../client";
import { runMigrations } from "../migrate";

const { db, close } = createDb();
try {
  await runMigrations(db);
  console.log("Migrations applied.");
} finally {
  await close();
}
