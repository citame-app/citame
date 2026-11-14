import type { Database } from "@sob/db";
import type { NotificationConfig } from "../config";
import { createProviders } from "./providers";
import { createNotificationWorker, type NotificationWorker } from "./worker";

export interface NotificationRuntime {
  worker: NotificationWorker;
  /** Stops polling, waits for the job in flight and closes provider connections. */
  stop(): Promise<void>;
}

/**
 * Starts the queue worker when `NOTIFY_WORKER_ENABLED` is on, else returns null. The API
 * process and the standalone `bun run worker` entrypoint share this, so the two modes can
 * never drift apart. Any number of processes may run it at once (SKIP LOCKED).
 */
export function startNotificationRuntime(options: {
  db: Database;
  config: { notifications: NotificationConfig };
  log?: (entry: Record<string, unknown>) => void;
}): NotificationRuntime | null {
  const { notifications } = options.config;
  if (!notifications.workerEnabled) return null;
  const providers = createProviders(notifications);
  const worker = createNotificationWorker({
    db: options.db,
    config: notifications,
    providers,
    log: options.log,
  });
  worker.start();
  return {
    worker,
    async stop() {
      await worker.stop();
      await providers.email?.close?.();
      await providers.sms?.close?.();
    },
  };
}
