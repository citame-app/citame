import type { Database } from "@sob/db";
import type { AppConfig } from "../../config";
import { rootLogger } from "../../observability/logger";
import { recurringSettings } from "../../payments/recurring-settings";
import { RedsysGateway } from "../../payments/redsys";
import { runMembershipBilling } from "./billing";
/** Independent of notification workers. Database claims serialize API replicas. */
export function startMembershipBilling({ db, config }: { db: Database; config: AppConfig }) {
  const gateway = config.payments.redsys ? new RedsysGateway(config.payments.redsys) : null;
  if (!recurringSettings(config, gateway)) return null;
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    running = runMembershipBilling({ db, config, gateway, continueRunning: () => !stopped })
      .catch(() => rootLogger.error("membership billing cycle failed"))
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
