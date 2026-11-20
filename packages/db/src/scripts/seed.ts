import { createDb, DEFAULT_DATABASE_URL, NO_DB_TIMEOUTS } from "../client";
import { assertNotBooksyReviewDatabase, assertOperationalDatabase } from "../operational-database";
import { seedSampleData } from "../seed";

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
assertNotBooksyReviewDatabase(url);
const { db, close } = createDb(url, NO_DB_TIMEOUTS);
try {
  await assertOperationalDatabase(db);
  await seedSampleData(db);
  console.log("Sample data seeded.");
} finally {
  await close();
}
