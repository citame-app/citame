import type { Database } from "@sob/db";
import { rootLogger } from "../../observability/logger";
import { expireBookingHolds } from "./value";
/** Independent of email/payment configuration; receipt locks serialize replicas. */
export function startBookingExpiry(db: Database) {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    running = expireBookingHolds(db)
      .catch(() => rootLogger.error("booking hold expiry failed"))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 60000);
      });
  };
  timer = setTimeout(tick, 1000);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
