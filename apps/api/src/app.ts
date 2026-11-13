import type { HealthResponse } from "@sob/contracts";
import type { Database } from "@sob/db";
import { Hono } from "hono";
import { DomainError } from "./errors";
import { errorBody, respondError } from "./http";
import { appointmentsRoutes } from "./modules/appointments/routes";
import { availabilityRoutes } from "./modules/availability/routes";
import { servicesRoutes } from "./modules/services/routes";
import { staffRoutes } from "./modules/staff/routes";

export interface AppDeps {
  db: Database;
  /** Injectable clock so availability and notice rules are deterministic in tests. */
  now?: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

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

  // Phase 2: protect with RBAC (owner / staff / client). Every router below is open for now.
  app.route("/services", servicesRoutes(deps));
  app.route("/staff", staffRoutes(deps));
  app.route("/availability", availabilityRoutes(deps));
  app.route("/appointments", appointmentsRoutes(deps));

  return app;
}
