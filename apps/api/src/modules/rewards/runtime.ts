import type { Database } from "@sob/db";
import { rootLogger } from "../../observability/logger";
import { expireRewardReservations } from "./expiry";
import { expireLoyaltyLots } from "./value";
/** Expiry remains active when earning/redemption is disabled. */
export function startRewardsExpiry(db: Database) {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      await expireRewardReservations(db);
      if (!stopped) await expireLoyaltyLots(db);
    })()
      .catch(() => rootLogger.error("reward expiry failed"))
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
