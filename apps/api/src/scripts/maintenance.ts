import {
  assertNotBooksyReviewDatabase,
  assertOperationalDatabase,
  createDb,
  NO_DB_TIMEOUTS,
} from "@sob/db";
import { loadConfig } from "../config";
import { runMaintenance } from "../maintenance";

/**
 * One-shot housekeeping for external schedulers (cron, a Kubernetes CronJob):
 * `bun run maintenance`. Prints what it removed as JSON and exits non-zero on failure.
 */
const config = loadConfig();
assertNotBooksyReviewDatabase(config.databaseUrl);
const { db, close } = createDb(config.databaseUrl, NO_DB_TIMEOUTS);
try {
  await assertOperationalDatabase(db);
  const report = await runMaintenance(db, { retention: config.maintenance.retention });
  console.log(JSON.stringify(report));
} finally {
  await close();
}
