import type { RedisClient } from "bun";

/** Shape Better Auth expects for `secondaryStorage` (1.7). Values are JSON strings. */
export interface ValkeySecondaryStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttl: number): Promise<number>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
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
