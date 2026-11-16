import type { Database } from "@sob/db";
import { rootLogger } from "../../observability/logger";
import { runWaitlist } from "./matching";
export function startWaitlist(db: Database) {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    running = runWaitlist(db)
      .catch(() => rootLogger.error("waitlist scheduling failed"))
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
