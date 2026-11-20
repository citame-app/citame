import type { RedisClient } from "bun";
import { rootLogger } from "../../observability/logger";

/**
 * Fans Valkey pub/sub nudges out to the SSE connections of this process. One dedicated
 * subscriber connection per process (opened lazily on the first stream), however many clients
 * are connected. A nudge only says "the log head moved"; it carries no data, so a lost one is
 * harmless: clients also pull on reconnect and on a slow timer.
 */
export function createSyncHub(options: {
  valkey: RedisClient;
  keyPrefix: string;
  /** Repair missed pub/sub messages and observe commits from background workers. */
  readHead?: () => Promise<number>;
}) {
  const channel = `${options.keyPrefix}sync:nudge`;
  const listeners = new Set<(seq: number) => void>();
  const closers = new Set<() => void>();
  let subscriber: RedisClient | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let polling: ReturnType<typeof setInterval> | undefined;
  let reading = false;

  function startPolling() {
    const readHead = options.readHead;
    if (!readHead || polling) return;
    polling = setInterval(async () => {
      if (reading || closed) return;
      reading = true;
      try {
        const seq = await readHead();
        for (const listener of listeners) listener(seq);
      } catch (error) {
        rootLogger.error("sync hub could not read committed head", { err: error });
      } finally {
        reading = false;
      }
    }, 1000);
  }

  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = undefined;
  }

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
      try {
        await ensureStarted();
      } catch (error) {
        if (!options.readHead) throw error;
        rootLogger.error("sync hub is using the database while Valkey is unavailable", {
          err: error,
        });
      }
      if (closed) throw new Error("sync hub is closed");
      listeners.add(listener);
      closers.add(onShutdown);
      startPolling();
      return () => {
        listeners.delete(listener);
        closers.delete(onShutdown);
        if (!listeners.size) stopPolling();
      };
    },
    async publish(seq: number) {
      await options.valkey.publish(channel, String(seq));
    },
    /** Ends every open stream and releases the subscriber connection. */
    async close() {
      closed = true;
      stopPolling();
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
