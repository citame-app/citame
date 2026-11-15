import { createDb, NO_DB_TIMEOUTS } from "../client";
import { seedSampleData } from "../seed";

const { db, close } = createDb(undefined, NO_DB_TIMEOUTS);
try {
  await seedSampleData(db);
  console.log("Sample data seeded.");
} finally {
  await close();
}
