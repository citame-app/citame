import type { RedisClient } from "bun";

/**
 * Fans Valkey pub/sub nudges out to the SSE connections of this process. One dedicated
 * subscriber connection per process (opened lazily on the first stream), however many clients
 * are connected. A nudge only says "the log head moved"; it carries no data, so a lost one is
 * harmless: clients also pull on reconnect and on a slow timer.
 */
export function createSyncHub(options: { valkey: RedisClient; keyPrefix: string }) {
  const channel = `${options.keyPrefix}sync:nudge`;
  const listeners = new Set<(seq: number) => void>();
  const closers = new Set<() => void>();
  let subscriber: RedisClient | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;

  async function start() {
    const sub = await options.valkey.duplicate();
    await sub.subscribe(channel, (message: string) => {
      const seq = Number(message);
      if (Number.isFinite(seq)) for (const listener of listeners) listener(seq);
    });
    if (closed) {
      sub.close();
      return;
    }
    subscriber = sub;
  }

  return {
    /** Registers a nudge listener (subscribing to Valkey first if needed); returns its remover. */
    async subscribe(listener: (seq: number) => void, onShutdown: () => void) {
      if (closed) throw new Error("sync hub is closed");
      starting ??= start();
      await starting;
      listeners.add(listener);
      closers.add(onShutdown);
      return () => {
        listeners.delete(listener);
        closers.delete(onShutdown);
      };
    },
    async publish(seq: number) {
      await options.valkey.publish(channel, String(seq));
    },
    /** Ends every open stream and releases the subscriber connection. */
    async close() {
      closed = true;
      for (const end of [...closers]) end();
      closers.clear();
      listeners.clear();
      await starting?.catch(() => {});
      subscriber?.close();
      subscriber = undefined;
    },
  };
}

export type SyncHub = ReturnType<typeof createSyncHub>;
