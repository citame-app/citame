import type { Database } from "@sob/db";
import type { NotificationConfig } from "../config";
import type { AuthEmailKind } from "../notifications/auth-emails";
import type { EmailProvider } from "../notifications/providers/types";
import type { Locale } from "../notifications/templates";
import type { Logger } from "../observability/logger";
import { createAccountEmailWorker, enqueueAccountEmail } from "./outbox";

export interface AuthMailRequest {
  kind: AuthEmailKind;
  to: string;
  url: string;
  locale: Locale;
  expiresInMinutes: number;
  idempotencyKey: string;
}

export interface AuthMailer {
  /** Resolves after durable enqueue; delivery never delays the HTTP response. */
  send(request: AuthMailRequest): Promise<void>;
  flush(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createAuthMailer(deps: {
  provider: EmailProvider | null;
  db: Database;
  secret: string;
  config: NotificationConfig;
  logger: Logger;
}): AuthMailer {
  const worker = createAccountEmailWorker(deps);
  let stopped = false;
  let again = false;
  let delivery: Promise<void> | undefined;
  const kick = () => {
    again = true;
    delivery ??= (async () => {
      while (again) {
        again = false;
        await worker.runOnce();
      }
    })()
      .catch(() => {
        // Never log provider exceptions: they may contain recipient addresses or action links.
        deps.logger.error("account email poll failed; durable jobs will be retried");
      })
      .finally(() => {
        delivery = undefined;
      });
    return delivery;
  };
  const flush = async () => {
    await delivery;
    while (await worker.runOnce()) {
      /* Drain due batches, leaving delayed retries persisted. */
    }
  };
  return {
    async send(request) {
      if (!deps.provider) {
        deps.logger.warn("account email not sent: no email provider is configured");
        return;
      }
      const result = await enqueueAccountEmail(deps.db, deps.secret, request);
      deps.logger.info("account email enqueue", { kind: request.kind, result });
      if (result === "queued" && !stopped) void kick();
    },
    flush,
    start() {
      if (deps.provider && !stopped) worker.start();
    },
    async stop() {
      stopped = true;
      await worker.stop();
      await flush();
      await deps.provider?.close?.();
    },
  };
}
