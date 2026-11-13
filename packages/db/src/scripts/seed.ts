import { createDb } from "../client";
import { seedSampleData } from "../seed";

const { db, close } = createDb();
try {
  await seedSampleData(db);
  console.log("Sample data seeded.");
} finally {
  await close();
}
