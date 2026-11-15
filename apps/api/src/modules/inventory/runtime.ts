import type { Database } from "@sob/db";
import { rootLogger } from "../../observability/logger";
import { expireInventoryHolds } from "./reservations";
/** Independent from email configuration; safe across API/worker replicas. */
export function startInventoryExpiry(db: Database) {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    running = expireInventoryHolds(db)
      .catch((error) => rootLogger.error("inventory expiry failed", { err: error }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 60_000);
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
