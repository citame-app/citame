import type { RedisClient } from "bun";
import { rootLogger } from "../../observability/logger";

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
    try {
      await sub.subscribe(channel, (message: string) => {
        const seq = Number(message);
        if (Number.isFinite(seq)) for (const listener of listeners) listener(seq);
      });
    } catch (error) {
      sub.close();
      throw error;
    }
    if (closed) {
      sub.close();
      return;
    }
    // A dropped subscriber would leave every open stream deaf to nudges: forget it and, if anyone
    // is listening, subscribe again right away (the next stream retries too if this fails).
    sub.onclose = () => {
      if (subscriber !== sub) return;
      subscriber = undefined;
      starting = undefined;
      if (!closed && listeners.size > 0) {
        ensureStarted().catch((error) =>
          rootLogger.error("sync hub could not re-subscribe", { err: error }),
        );
      }
    };
    subscriber = sub;
  }

  /** One in-flight start at a time. A failed start is forgotten so the next caller retries. */
  function ensureStarted(): Promise<void> {
    if (!starting) {
      const attempt = start();
      starting = attempt;
      attempt.catch(() => {
        if (starting === attempt) starting = undefined;
      });
    }
    return starting;
  }

  return {
    /** Registers a nudge listener (subscribing to Valkey first if needed); returns its remover. */
    async subscribe(listener: (seq: number) => void, onShutdown: () => void) {
      if (closed) throw new Error("sync hub is closed");
      await ensureStarted();
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
