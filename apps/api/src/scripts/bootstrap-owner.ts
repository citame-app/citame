/**
 * Idempotent first-owner bootstrap: `bun run bootstrap:owner`.
 * Reads OWNER_EMAIL, OWNER_PASSWORD (and optionally OWNER_NAME) from the environment.
 * The password is never logged. Safe to run on every deploy.
 */
import { assertNotBooksyReviewDatabase, assertOperationalDatabase, createDb } from "@sob/db";
import { RedisClient } from "bun";
import { bootstrapOwner, ownerFromEnv } from "../auth/accounts";
import { createAuth } from "../auth/auth";
import { loadConfig } from "../config";

const config = loadConfig();
assertNotBooksyReviewDatabase(config.databaseUrl);
const owner = ownerFromEnv(process.env);
const { db, close } = createDb(config.databaseUrl);
const valkey = new RedisClient(config.valkeyUrl);

try {
  await assertOperationalDatabase(db);
  const auth = createAuth({ db, valkey, config });
  // The no-op path does not hash a password, so wait for Better Auth's async
  // initialization explicitly before either path can close the database.
  await auth.$context;
  const result = await bootstrapOwner({ auth, db }, owner);
  console.log(
    result.created
      ? `Owner account created for ${owner.email}.`
      : `Owner account for ${owner.email} already exists; nothing changed.`,
  );
} finally {
  valkey.close();
  await close();
}
