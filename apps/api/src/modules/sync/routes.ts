import { syncPullQuerySchema, syncPushRequestSchema } from "@sob/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import type { SyncHub } from "./hub";
import { headSeq, pullChanges } from "./pull";
import { pushMutations } from "./push";

/** Mounted at `/sync` behind `requireAuth`. Sync is for the front desk: owner and staff only. */
export function syncRoutes(
  { db, now = () => new Date(), syncHeartbeatMs = 15_000 }: AppDeps,
  hub: SyncHub,
  streamLimit: MiddlewareHandler,
) {
  return (
    new Hono<AppEnv>()
      .use("*", async (c, next) => {
        requireRole(c.get("principal"), "owner", "staff");
        await next();
      })
      .post("/push", async (c) => {
        const request = parseOrThrow(syncPushRequestSchema, await readJson(c));
        return c.json(await pushMutations({ db, now }, c.get("principal"), request));
      })
      .get("/pull", async (c) => {
        const query = parseOrThrow(syncPullQuerySchema, c.req.query());
        return c.json(await pullChanges(db, c.get("principal"), query));
      })
      // Server-sent events: a nudge carries only the head seq; the client then calls /sync/pull.
      .get("/stream", streamLimit, (c) =>
        streamSSE(c, async (stream) => {
          const send = (seq: number) =>
            stream.writeSSE({ event: "change", data: JSON.stringify({ seq }), id: String(seq) });
          // Subscribe before reading the head so a write in between cannot be missed.
          const unsubscribe = await hub.subscribe(
            (seq) => void send(seq).catch(() => {}),
            () => void stream.close(),
          );
          stream.onAbort(unsubscribe);
          try {
            await send(await headSeq(db));
            while (!stream.aborted && !stream.closed) {
              await stream.sleep(syncHeartbeatMs);
              if (!stream.aborted && !stream.closed) await stream.write(": ping\n\n");
            }
          } finally {
            unsubscribe();
          }
        }),
      )
  );
}
