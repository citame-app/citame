import type { HealthResponse } from "@sob/contracts";
import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { Hono } from "hono";
import { createAuth } from "./auth/auth";
import { requireAuth } from "./auth/principal";
import { valkeySecondaryStorage } from "./auth/secondary-storage";
import type { AppConfig } from "./config";
import { DomainError } from "./errors";
import { errorBody, respondError } from "./http";
import { adminRoutes } from "./modules/admin/routes";
import { appointmentsRoutes } from "./modules/appointments/routes";
import { availabilityRoutes } from "./modules/availability/routes";
import { clientAdminRoutes } from "./modules/clients/admin-routes";
import { meRoutes } from "./modules/me/routes";
import { reportRoutes } from "./modules/reports/routes";
import { serviceAdminRoutes } from "./modules/services/admin-routes";
import { servicesRoutes } from "./modules/services/routes";
import { settingsAdminRoutes } from "./modules/settings/admin-routes";
import { salonRoutes } from "./modules/settings/routes";
import { staffAdminRoutes } from "./modules/staff/admin-routes";
import { staffRoutes } from "./modules/staff/routes";
import { createSyncHub } from "./modules/sync/hub";
import { headSeq } from "./modules/sync/pull";
import { syncRoutes } from "./modules/sync/routes";
import { createRateLimiter, rateLimit } from "./rate-limit";

export interface AppDeps {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
  /** Epoch-ms clock for rate limit windows. */
  rateLimitNow?: () => number;
  /** Injectable clock so availability and notice rules are deterministic in tests. */
  now?: () => Date;
  /** Interval of the SSE keep-alive comment, in milliseconds (default 15 000). */
  syncHeartbeatMs?: number;
}

/** The Hono app plus the lifecycle hook that releases long-lived resources (SSE, Valkey). */
export type App = Hono & { shutdown: () => Promise<void> };

export function createApp(deps: AppDeps): App {
  const app = new Hono() as App;
  const auth = createAuth(deps);
  const limiter = createRateLimiter({
    storage: valkeySecondaryStorage(deps.valkey, deps.config.valkeyKeyPrefix),
    now: deps.rateLimitNow,
  });
  const { trustProxy, rateLimit: limits } = deps.config;
  const hub = createSyncHub({ valkey: deps.valkey, keyPrefix: deps.config.valkeyKeyPrefix });
  app.shutdown = () => hub.close();

  app.onError((error, c) => {
    if (error instanceof DomainError) return respondError(c, error);
    console.error(error);
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

  // Liveness stays outside every limiter so orchestrator probes can never be throttled.
  app.get("/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });

  // Moderate limit for everything else, strict one for credential endpoints (brute force).
  // The global limiter fails open (a Valkey outage must not take public browsing down); the
  // auth limiter fails closed.
  app.use(
    "*",
    rateLimit({ limiter, scope: "global", rule: limits.global, trustProxy, failOpen: true }),
  );
  // After every mutating request, tell connected sync clients that the change log moved. The
  // log is written inside the request's own transaction, so by now the change is committed.
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
    try {
      await hub.publish(await headSeq(deps.db));
    } catch (error) {
      console.error("sync nudge failed", error);
    }
  });
  const authLimit = rateLimit({ limiter, scope: "auth", rule: limits.auth, trustProxy });
  app.use("/api/auth/sign-in/*", authLimit);
  app.use("/api/auth/sign-up/*", authLimit);

  // Better Auth owns everything under /api/auth (sign-up, sign-in, sign-out, session).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use("/me", requireAuth(auth, deps.db));
  app.route("/me", meRoutes(deps));

  app.use("/admin/*", requireAuth(auth, deps.db));
  app.route("/admin", adminRoutes(deps, auth));
  app.route("/admin/services", serviceAdminRoutes(deps));
  app.route("/admin/staff", staffAdminRoutes(deps));
  app.route("/admin/clients", clientAdminRoutes(deps));
  app.route("/admin/reports", reportRoutes(deps));
  app.route("/admin/settings", settingsAdminRoutes(deps));

  // Public catalog and availability: anonymous visitors browse before they sign up.
  app.route("/salon", salonRoutes(deps));
  app.route("/services", servicesRoutes(deps));
  app.route("/staff", staffRoutes(deps));
  app.route("/availability", availabilityRoutes(deps));
  // Everything that touches appointments needs a session; the routes enforce the role policy.
  app.use("/appointments", requireAuth(auth, deps.db));
  app.use("/appointments/*", requireAuth(auth, deps.db));
  app.route("/appointments", appointmentsRoutes(deps));

  app.use("/sync/*", requireAuth(auth, deps.db));
  const streamLimit = rateLimit({
    limiter,
    scope: "sync-stream",
    rule: limits.syncStream,
    trustProxy,
    failOpen: true,
  });
  app.route("/sync", syncRoutes(deps, hub, streamLimit));

  return app;
}
