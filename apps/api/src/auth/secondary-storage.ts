import { createHash } from "node:crypto";
import { type Database, verification } from "@sob/db";
import type { RedisClient } from "bun";
import { and, eq, gt } from "drizzle-orm";

/** Shape Better Auth expects for `secondaryStorage` (1.7). Values are JSON strings. */
export interface ValkeySecondaryStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttl: number): Promise<number>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const INVITATION_PREFIX = "sob-staff-invite-";
const INVITATION_STORAGE_PREFIX = `verification:reset-password:${INVITATION_PREFIX}`;
const invitationIdentifier = (token: string) =>
  `staff-invitation:${createHash("sha256").update(token).digest("hex")}`;

/** The account, invitation digest and encrypted email can commit together. */
export async function createStaffInvitation(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  userId: string,
  expiresAt: Date,
) {
  const token =
    INVITATION_PREFIX +
    Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  await tx.insert(verification).values({
    id: Bun.randomUUIDv7(),
    identifier: invitationIdentifier(token),
    value: userId,
    expiresAt,
  });
  return token;
}

/** Keep existing reset/OAuth state in Valkey and make new staff invitations restore with SQL. */
export function withStaffInvitations(
  db: Database,
  valkey: ValkeySecondaryStorage,
): ValkeySecondaryStorage {
  const identifier = (key: string) =>
    invitationIdentifier(key.slice("verification:reset-password:".length));
  const deleteInvite = (key: string) =>
    db.delete(verification).where(eq(verification.identifier, identifier(key)));
  return {
    ...valkey,
    async get(key) {
      if (!key.startsWith(INVITATION_STORAGE_PREFIX)) return valkey.get(key);
      const [row] = await db
        .select()
        .from(verification)
        .where(
          and(eq(verification.identifier, identifier(key)), gt(verification.expiresAt, new Date())),
        )
        .limit(1);
      return row ? JSON.stringify(row) : null;
    },
    async getAndDelete(key) {
      if (!key.startsWith(INVITATION_STORAGE_PREFIX)) return valkey.getAndDelete(key);
      const [row] = await deleteInvite(key).returning();
      return row ? JSON.stringify(row) : null;
    },
    async delete(key) {
      if (key.startsWith(INVITATION_STORAGE_PREFIX)) await deleteInvite(key);
      else await valkey.delete(key);
    },
  };
}

/**
 * INCR and EXPIRE in one atomic step. The TTL is only applied when the key has none, so
 * repeated increments never extend a window, and a crash between the two commands of a
 * non-atomic implementation can never leave an immortal counter.
 */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Valkey-backed `secondaryStorage` for Better Auth, using Bun's built-in Redis client.
 * `prefix` namespaces every key so environments (and test runs) can share one server.
 */
export function valkeySecondaryStorage(
  client: RedisClient,
  prefix: string,
): ValkeySecondaryStorage {
  const k = (key: string) => `${prefix}${key}`;
  return {
    get: (key) => client.get(k(key)),
    getAndDelete: (key) => client.getdel(k(key)),
    async increment(key, ttl) {
      if (!Number.isInteger(ttl) || ttl <= 0) {
        throw new TypeError("Valkey increment TTL must be a positive integer");
      }
      const count = await client.send("EVAL", [INCREMENT_SCRIPT, "1", k(key), String(ttl)]);
      return Number(count);
    },
    async set(key, value, ttl) {
      if (ttl && ttl > 0) await client.set(k(key), value, "EX", Math.ceil(ttl));
      else await client.set(k(key), value);
    },
    async delete(key) {
      await client.del(k(key));
    },
  };
}
