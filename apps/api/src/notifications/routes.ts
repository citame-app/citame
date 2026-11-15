import {
  notificationStatsSchema,
  optOutRequestSchema,
  updateNotificationPreferencesRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { accountEmailQueueStats } from "../auth/outbox";
import { requireRole } from "../auth/policy";
import type { AppEnv } from "../auth/principal";
import { DomainError } from "../errors";
import { parseOrThrow, readJson } from "../http";
import { processMetrics } from "./metrics";
import {
  applyOptOut,
  getPreferences,
  previewOptOut,
  queueStats,
  updatePreferences,
} from "./service";

/** Mounted inside `/me` (session required): a client's own preferences. */
export function preferenceRoutes({ db }: Pick<AppDeps, "db">) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const { clientId } = c.get("principal");
      if (!clientId)
        throw new DomainError("forbidden", "Only clients have notification preferences");
      return c.json(await getPreferences(db, clientId));
    })
    .patch("/", async (c) => {
      const principal = c.get("principal");
      if (!principal.clientId) {
        throw new DomainError("forbidden", "Only clients have notification preferences");
      }
      const body = parseOrThrow(updateNotificationPreferencesRequestSchema, await readJson(c));
      return c.json(await updatePreferences(db, principal.clientId, principal.userId, body));
    });
}

/**
 * Public opt-out, mounted at `/notifications`. A GET only describes what the link would do:
 * mail scanners and link previews fetch URLs, so a GET must never change anything. The POST
 * accepts the token in the JSON body (the web page) or the query string (RFC 8058 one-click
 * `List-Unsubscribe-Post`, sent by mail clients).
 */
export function optOutRoutes({ db, config }: Pick<AppDeps, "db" | "config">) {
  const secret = config.notifications.signingSecret;
  return new Hono()
    .get("/opt-out", async (c) =>
      c.json(await previewOptOut(db, secret, c.req.query("token") ?? "")),
    )
    .post("/opt-out", async (c) => {
      const fromQuery = c.req.query("token");
      const token = fromQuery ?? parseOrThrow(optOutRequestSchema, await readJson(c)).token;
      return c.json(await applyOptOut(db, secret, token));
    });
}

/** Owner-only operational view, mounted at `/admin/notifications`. */
export function notificationAdminRoutes({ db, config }: Pick<AppDeps, "db" | "config">) {
  return new Hono<AppEnv>().get("/stats", async (c) => {
    requireRole(c.get("principal"), "owner");
    return c.json(
      notificationStatsSchema.parse({
        queue: await queueStats(db),
        accountEmails: await accountEmailQueueStats(db),
        worker: processMetrics.snapshot(),
        channels: {
          email: config.notifications.email.provider !== "none",
          sms: config.notifications.sms.provider !== "none",
        },
      }),
    );
  });
}
