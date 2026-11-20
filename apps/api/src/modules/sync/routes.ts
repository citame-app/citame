import { initialSyncGeneration, syncPullQuerySchema, syncPushRequestSchema } from "@sob/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { BearerError, type TokenVerifier } from "../../mcp/verify";
import { isDesktopDeviceBearer } from "../../oauth/desktop-devices";
import type { SyncHub } from "./hub";
import { headSeq, pullChanges } from "./pull";
import { pushMutations } from "./push";

/** Mounted at `/sync` behind `requireAuth`. Sync is for the front desk: owner and staff only. */
export function syncRoutes(
  { db, config, now = () => new Date(), syncHeartbeatMs = 15_000, metrics }: AppDeps,
  hub: SyncHub,
  streamLimit: MiddlewareHandler,
  desktop?: TokenVerifier,
) {
  const generation = config.syncReplicaGeneration;
  return (
    new Hono<AppEnv>()
      .use("*", async (c, next) => {
        requireRole(c.get("principal"), "owner", "staff");
        await next();
      })
      .post("/push", async (c) => {
        const request = parseOrThrow(syncPushRequestSchema, await readJson(c));
        if ((request.generation ?? initialSyncGeneration) !== generation) {
          throw new DomainError(
            "sync_generation_changed",
            "Refresh the restored replica before sending changes",
          );
        }
        const response = await pushMutations({ db, now }, c.get("principal"), request);
        for (const result of response.results) {
          metrics?.syncPush.inc({
            status: result.status,
            reason: result.status === "rejected" ? result.reason : "",
          });
        }
        return c.json(response);
      })
      .get("/pull", async (c) => {
        const query = parseOrThrow(syncPullQuerySchema, c.req.query());
        const response = await pullChanges(db, c.get("principal"), query);
        metrics?.syncPull.inc();
        metrics?.syncPullChanges.inc({}, response.changes.length);
        return c.json({ ...response, generation });
      })
      // Server-sent events: a nudge carries only the head seq; the client then calls /sync/pull.
      .get("/stream", streamLimit, (c) => {
        c.header("X-Accel-Buffering", "no");
        const bearer = c.req.header("authorization");
        const response = streamSSE(c, async (stream) => {
          let lastSent: number | undefined;
          let queued = 0;
          const send = (seq: number) => {
            if (lastSent === undefined) {
              queued = Math.max(queued, seq);
              return;
            }
            if (seq <= lastSent) return;
            lastSent = seq;
            return stream.writeSSE({
              event: "change",
              data: JSON.stringify({ seq }),
              id: String(seq),
            });
          };
          // Subscribe before reading the head so a write in between cannot be missed.
          const unsubscribe = await hub.subscribe(
            (seq) => void send(seq)?.catch(() => {}),
            () => void stream.close(),
          );
          stream.onAbort(unsubscribe);
          try {
            const initial = Math.max(await headSeq(db), queued);
            lastSent = -1;
            await send(initial);
            while (!stream.aborted && !stream.closed) {
              await stream.sleep(syncHeartbeatMs);
              if (stream.aborted || stream.closed) break;
              if (desktop && isDesktopDeviceBearer(bearer)) {
                try {
                  await desktop.verify(bearer);
                } catch (error) {
                  if (error instanceof BearerError) break;
                  throw error;
                }
              }
              await stream.write(": ping\n\n");
            }
          } finally {
            unsubscribe();
          }
        });
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      })
  );
}
