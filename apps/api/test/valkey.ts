import { RedisClient } from "bun";

export const DEFAULT_TEST_VALKEY_URL = "redis://localhost:6379";

export interface TestValkey {
  client: RedisClient;
  /** Unique per call, so parallel test files and repeated runs never see each other's keys. */
  prefix: string;
  /** Deletes every key under this handle's prefix. */
  clear: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Connects to the real Valkey from compose (`VALKEY_URL`). Fails loudly with an actionable
 * message when it is unreachable: integration tests never skip silently.
 */
export async function createTestValkey(label: string): Promise<TestValkey> {
  const url = process.env.VALKEY_URL ?? DEFAULT_TEST_VALKEY_URL;
  const client = new RedisClient(url, { connectionTimeout: 3000, maxRetries: 1 });
  try {
    await client.send("PING", []);
  } catch (error) {
    client.close();
    throw new Error(
      `Integration tests need Valkey at ${url} but it is unreachable ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Start it with `docker compose up -d --wait valkey` or set VALKEY_URL.",
    );
  }
  const prefix = `sob-test:${label}:${Bun.randomUUIDv7()}:`;

  const clear = async () => {
    let cursor = "0";
    do {
      const reply = (await client.send("SCAN", [
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        "500",
      ])) as [string, string[]];
      cursor = reply[0];
      if (reply[1].length > 0) await client.send("DEL", reply[1]);
    } while (cursor !== "0");
  };

  return {
    client,
    prefix,
    clear,
    close: async () => {
      await clear();
      client.close();
    },
  };
}
