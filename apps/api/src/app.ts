import type { HealthResponse } from "@sob/contracts";
import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { Hono } from "hono";
import { createAuth } from "./auth/auth";
import { requireAuth } from "./auth/principal";
import type { AppConfig } from "./config";
import { DomainError } from "./errors";
import { errorBody, respondError } from "./http";
import { appointmentsRoutes } from "./modules/appointments/routes";
import { availabilityRoutes } from "./modules/availability/routes";
import { meRoutes } from "./modules/me/routes";
import { servicesRoutes } from "./modules/services/routes";
import { staffRoutes } from "./modules/staff/routes";

export interface AppDeps {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
  /** Epoch-ms clock for rate limit windows. */
  rateLimitNow?: () => number;
  /** Injectable clock so availability and notice rules are deterministic in tests. */
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const auth = createAuth(deps);

  app.onError((error, c) => {
    if (error instanceof DomainError) return respondError(c, error);
    console.error(error);
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

  app.get("/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });

  // Better Auth owns everything under /api/auth (sign-up, sign-in, sign-out, session).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use("/me", requireAuth(auth, deps.db));
  app.route("/me", meRoutes());

  // Public catalog and availability: anonymous visitors browse before they sign up.
  app.route("/services", servicesRoutes(deps));
  app.route("/staff", staffRoutes(deps));
  app.route("/availability", availabilityRoutes(deps));
  // Everything that touches appointments needs a session; the routes enforce the role policy.
  app.use("/appointments", requireAuth(auth, deps.db));
  app.use("/appointments/*", requireAuth(auth, deps.db));
  app.route("/appointments", appointmentsRoutes(deps));

  return app;
}
