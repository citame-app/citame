import type { HealthResponse } from "@sob/contracts";
import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth/auth";
import { requireAuth } from "./auth/principal";
import { valkeySecondaryStorage } from "./auth/secondary-storage";
import type { AppConfig } from "./config";
import { DomainError } from "./errors";
import { errorBody, respondError } from "./http";
import { mcpRoutes } from "./mcp/routes";
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
import type { EmailProvider } from "./notifications/providers/types";
import { notificationAdminRoutes, optOutRoutes } from "./notifications/routes";
import { oauthAudit } from "./oauth/audit";
import { ensureOAuthSeeds } from "./oauth/clients";
import {
  type AppMetrics,
  createAppMetrics,
  registerRuntimeGauges,
} from "./observability/app-metrics";
import { requestContext } from "./observability/http";
import { type Logger, rootLogger } from "./observability/logger";
import { checkReady } from "./observability/ready";
import { createRateLimiter, rateLimit } from "./rate-limit";
import { bearerMatches, originCheck, securityHeaders } from "./security";

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
  /** Minimum gap between JWKS refetches for unknown key ids (default 10 000 ms). */
  jwksRefetchMs?: number;
  /** Prometheus registry and counters; every app gets its own unless one is injected. */
  metrics?: AppMetrics;
  /** Structured logger; defaults to JSON lines on stdout. */
  logger?: Logger;
  /** Sends account emails (verification, reset, invitation). Null or absent: skipped with a warning. */
  emailProvider?: EmailProvider | null;
  /** Per-dependency timeout of `/ready` and of the gauges sampled by `/metrics` (default 2 000 ms). */
  readyTimeoutMs?: number;
}

/** The Hono app plus the lifecycle hook that releases long-lived resources (SSE, Valkey). */
export type App = Hono & {
  shutdown: () => Promise<void>;
  /** Marks the instance as draining: `/ready` answers 503 so the load balancer stops sending traffic. */
  drain: () => void;
  /** Seeds the OAuth resource and first-party clients; resolves when the app is ready to serve OAuth flows. */
  ready: () => Promise<void>;
};

export function createApp(input: AppDeps): App {
  const metrics = input.metrics ?? createAppMetrics();
  const logger = input.logger ?? rootLogger;
  const deps: AppDeps = { ...input, metrics, logger };
  registerRuntimeGauges(metrics, deps, { timeoutMs: input.readyTimeoutMs });
  const app = new Hono() as App;
  const auth = createAuth({ ...deps, emailProvider: deps.emailProvider ?? null });
  const limiter = createRateLimiter({
    storage: valkeySecondaryStorage(deps.valkey, deps.config.valkeyKeyPrefix),
    now: deps.rateLimitNow,
  });
  const { trustProxy, rateLimit: limits } = deps.config;
  const hub = createSyncHub({ valkey: deps.valkey, keyPrefix: deps.config.valkeyKeyPrefix });
  let draining = false;
  app.drain = () => {
    draining = true;
  };
  app.shutdown = async () => {
    await Promise.all([hub.close(), auth.mailer.flush()]);
  };
  app.ready = () => ensureOAuthSeeds(deps.db, deps.config);

  app.onError((error, c) => {
    if (error instanceof DomainError) return respondError(c, error);
    logger.error("unhandled error", { err: error });
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

  // Outermost: request id, access log and HTTP metrics for everything, probes excepted from the log.
  app.use(
    "*",
    requestContext({ logger, http: metrics.http, quietPaths: ["/health", "/ready", "/metrics"] }),
  );
  app.use("*", securityHeaders({ hsts: deps.config.auth.secureCookies }));

  // Liveness: the process is up and its event loop turns. It never asks a dependency, so an
  // outage of Postgres or Valkey does not get the container restarted for no benefit.
  app.get("/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });
  // Readiness: can this instance serve traffic (Postgres + Valkey answer)? 503 takes it out of
  // rotation. Both probes stay outside every limiter.
  app.get("/ready", async (c) => {
    c.header("cache-control", "no-store");
    if (draining) return c.json({ status: "draining" }, 503);
    const report = await checkReady(deps, deps.readyTimeoutMs);
    return c.json(report, report.status === "ready" ? 200 : 503);
  });
  // Prometheus scrape. With METRICS_TOKEN it needs the bearer token; without one it answers only
  // requests that did not arrive through the public proxy (which always adds forwarding headers).
  app.get("/metrics", async (c) => {
    const token = deps.config.metricsToken;
    if (token) {
      if (!bearerMatches(c.req.header("authorization"), token)) {
        return c.json(errorBody("unauthorized", "Metrics token required"), 401);
      }
    } else if (
      c.req.header("x-forwarded-for") ||
      c.req.header("x-forwarded-host") ||
      c.req.header("forwarded")
    ) {
      return c.json(errorBody("not_found", "Route not found"), 404);
    }
    c.header("cache-control", "no-store");
    return c.text(await metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  const trustedOrigins = [
    new URL(deps.config.auth.baseURL).origin,
    ...deps.config.auth.trustedOrigins,
  ];
  const sameOrigin = originCheck(trustedOrigins);
  for (const prefix of ["/appointments", "/me", "/admin", "/sync"]) {
    app.use(prefix, sameOrigin);
    app.use(`${prefix}/*`, sameOrigin);
  }

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
      logger.error("sync nudge failed", { err: error });
    }
  });
  const authLimit = rateLimit({ limiter, scope: "auth", rule: limits.auth, trustProxy });
  app.use("/api/auth/sign-in/*", authLimit);
  app.use("/api/auth/sign-up/*", authLimit);
  // Endpoints that send mail or consume emailed tokens: same budget as credentials, counted apart
  // so a burst of sign-ins cannot lock someone out of resetting their password (and vice versa).
  const accountEmailLimit = rateLimit({
    limiter,
    scope: "auth-email",
    rule: limits.auth,
    trustProxy,
  });
  for (const path of [
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/reset-password/*",
    "/api/auth/send-verification-email",
    "/api/auth/verify-email",
  ]) {
    app.use(path, accountEmailLimit);
  }

  // OAuth 2.1 authorization server (Better Auth oauth-provider plugin). Anonymous registration
  // has its own, stricter counter; the rest of the protocol endpoints share one.
  const registerLimit = rateLimit({
    limiter,
    scope: "oauth-register",
    rule: limits.oauthRegister,
    trustProxy,
  });
  const oauthLimit = rateLimit({ limiter, scope: "oauth", rule: limits.oauth, trustProxy });
  app.use("/api/auth/oauth2/register", registerLimit);
  app.use("/api/auth/oauth2/token", oauthLimit);
  app.use("/api/auth/oauth2/authorize", oauthLimit);
  app.use("/api/auth/oauth2/consent", oauthLimit);
  app.use("/api/auth/oauth2/revoke", oauthLimit);
  app.use("/api/auth/oauth2/introspect", oauthLimit);
  // Browser-based MCP clients read metadata and talk to the token endpoint cross-origin. These
  // endpoints never rely on cookies (PKCE, bearer or anonymous), so a wildcard origin without
  // credentials is safe; cookie-bound endpoints (authorize, consent) get no CORS headers.
  const publicCors = cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    maxAge: 600,
  });
  for (const path of [
    "/.well-known/*",
    "/api/auth/jwks",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/register",
    "/api/auth/oauth2/revoke",
  ]) {
    app.use(path, publicCors);
  }
  app.use("/api/auth/oauth2/*", oauthAudit(auth, deps.db));

  // MCP server (Streamable HTTP, stateless) and its RFC 9728 protected-resource metadata. The
  // `/mcp` endpoint answers CORS for browser-based clients; authentication is bearer-only.
  const mcp = mcpRoutes(deps, auth);
  for (const path of ["/mcp", "/mcp/*"]) app.use(path, publicCors);
  app.use(
    "/mcp",
    rateLimit({ limiter, scope: "mcp", rule: limits.mcp, trustProxy, failOpen: true }),
  );
  app.route("/mcp", mcp.app);
  for (const path of ["/.well-known/oauth-protected-resource", new URL(mcp.metadataUrl).pathname]) {
    app.get(path, (c) => c.json(mcp.metadata(), 200, { "Cache-Control": "public, max-age=300" }));
  }

  // Better Auth owns everything under /api/auth (sign-up, sign-in, sign-out, session).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // RFC 8414: the issuer is `<origin>/api/auth`, so its metadata lives at the origin root with
  // the issuer path appended. Better Auth answers these itself (plugin `onRequest`).
  app.on(["GET", "HEAD"], "/.well-known/oauth-authorization-server/api/auth", (c) =>
    auth.handler(c.req.raw),
  );
  app.use("/me", requireAuth(auth, deps.db));
  app.use("/me/*", requireAuth(auth, deps.db));
  app.route("/notifications", optOutRoutes(deps));
  app.route("/me", meRoutes(deps));

  app.use("/admin/*", requireAuth(auth, deps.db));
  app.route("/admin", adminRoutes(deps, auth));
  app.route("/admin/services", serviceAdminRoutes(deps));
  app.route("/admin/staff", staffAdminRoutes(deps));
  app.route("/admin/clients", clientAdminRoutes(deps));
  app.route("/admin/reports", reportRoutes(deps));
  app.route("/admin/settings", settingsAdminRoutes(deps));
  app.route("/admin/notifications", notificationAdminRoutes(deps));

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
