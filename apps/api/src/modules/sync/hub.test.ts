import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { createSyncHub } from "./hub";

/** A Valkey stand-in whose subscriber connections can be made to fail or to drop on demand. */
function fakeValkey(options: { failSubscribes?: number } = {}) {
  let failures = options.failSubscribes ?? 0;
  const subs: Array<{
    closed: boolean;
    onclose?: (error?: Error) => void;
    deliver: (message: string) => void;
  }> = [];
  const valkey = {
    async duplicate() {
      let handler: ((message: string) => void) | undefined;
      const sub = {
        closed: false,
        connected: true,
        onclose: undefined as ((error?: Error) => void) | undefined,
        deliver: (message: string) => handler?.(message),
        async subscribe(_channel: string, listener: (message: string) => void) {
          if (failures > 0) {
            failures -= 1;
            throw new Error("valkey unavailable");
          }
          handler = listener;
        },
        close() {
          sub.closed = true;
        },
      };
      subs.push(sub);
      return sub;
    },
    async publish() {},
  };
  return { valkey: valkey as unknown as RedisClient, subs };
}

describe("sync hub subscriber lifecycle", () => {
  test("a failed subscribe is not cached: the next stream retries and works", async () => {
    const { valkey, subs } = fakeValkey({ failSubscribes: 1 });
    const hub = createSyncHub({ valkey, keyPrefix: "t:" });

    await expect(
      hub.subscribe(
        () => {},
        () => {},
      ),
    ).rejects.toThrow("valkey unavailable");

    const seen: number[] = [];
    const off = await hub.subscribe(
      (seq) => seen.push(seq),
      () => {},
    );
    subs.at(-1)?.deliver("7");
    expect(seen).toEqual([7]);
    off();
    await hub.close();
  });

  test("the failed attempt's connection is released", async () => {
    const { valkey, subs } = fakeValkey({ failSubscribes: 1 });
    const hub = createSyncHub({ valkey, keyPrefix: "t:" });
    await hub
      .subscribe(
        () => {},
        () => {},
      )
      .catch(() => {});
    expect(subs[0]?.closed).toBe(true);
    await hub.close();
  });

  test("re-subscribes when the subscriber connection drops", async () => {
    const { valkey, subs } = fakeValkey();
    const hub = createSyncHub({ valkey, keyPrefix: "t:" });
    const seen: number[] = [];
    await hub.subscribe(
      (seq) => seen.push(seq),
      () => {},
    );
    expect(subs).toHaveLength(1);

    subs[0]?.onclose?.(new Error("connection lost"));
    // Let the background re-subscribe settle.
    await Bun.sleep(20);
    expect(subs.length).toBeGreaterThanOrEqual(2);

    subs.at(-1)?.deliver("9");
    expect(seen).toEqual([9]);
    await hub.close();
  });

  test("a later stream re-subscribes after a drop even if the background retry failed", async () => {
    const { valkey, subs } = fakeValkey();
    const hub = createSyncHub({ valkey, keyPrefix: "t:" });
    await hub.subscribe(
      () => {},
      () => {},
    );
    subs[0]?.onclose?.(new Error("connection lost"));
    await Bun.sleep(20);
    const seen: number[] = [];
    await hub.subscribe(
      (seq) => seen.push(seq),
      () => {},
    );
    subs.at(-1)?.deliver("3");
    expect(seen).toContain(3);
    await hub.close();
  });
});
