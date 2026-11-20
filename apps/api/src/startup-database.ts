import {
  assertOperationalDatabase,
  type Database,
  MigrationLedgerError,
  verifyMigrationLedger,
} from "@sob/db";
import { rootLogger } from "./observability/logger";

export async function checkServiceDatabase(db: Database): Promise<void> {
  await assertOperationalDatabase(db);
  if (process.env.NODE_ENV !== "production") return;
  try {
    await verifyMigrationLedger(db, { allowNewer: true });
  } catch (error) {
    rootLogger.error("database migration check failed", {
      reason:
        error instanceof MigrationLedgerError
          ? error.message
          : "Unable to read the PostgreSQL migration ledger",
    });
    process.exit(1);
  }
}
