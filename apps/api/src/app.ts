import type { CalendarResponse, HealthResponse } from "@sob/contracts";
import { type Database, jwks } from "@sob/db";
import type { RedisClient } from "bun";
import { gt, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth/auth";
import { type AppEnv, requireAuth } from "./auth/principal";
import { valkeySecondaryStorage } from "./auth/secondary-storage";
import type { AppConfig } from "./config";
import { DomainError } from "./errors";
import { errorBody, respondError } from "./http";
import { mcpRoutes } from "./mcp/routes";
import { createTokenVerifier } from "./mcp/verify";
import { accountingRoutes } from "./modules/accounting/routes";
import { adminRoutes } from "./modules/admin/routes";
import { appointmentsRoutes } from "./modules/appointments/routes";
import { availabilityRoutes } from "./modules/availability/routes";
import type { BooksySourceReadModel } from "./modules/booksy-transfer/source-read-model";
import { booksySourceRoutes } from "./modules/booksy-transfer/source-routes";
import { clientAdminRoutes } from "./modules/clients/admin-routes";
import {
  intakeAdminRoutes,
  intakeClientRoutes,
  intakeRoutes,
  intakeSelfRoutes,
} from "./modules/clients/intake-routes";
import {
  commerceAdminRoutes,
  commerceClientRoutes,
  redsysNotificationRoutes,
} from "./modules/commerce/routes";
import { giftCardRoutes, publicGiftOfferRoutes } from "./modules/gift-cards/routes";
import { inventoryRoutes } from "./modules/inventory/routes";
import {
  clientMarketingRoutes,
  marketingAdminRoutes,
  marketingPublicRoutes,
  selfMarketingRoutes,
} from "./modules/marketing/routes";
import { meRoutes } from "./modules/me/routes";
import { passRoutes, planAdminRoutes, publicPlanRoutes } from "./modules/passes/routes";
import { peakPriceAdminRoutes, peakPricePreviewRoute } from "./modules/peak-prices/routes";
import { reportRoutes } from "./modules/reports/routes";
import { portfolioAdminRoutes, portfolioPublicRoutes } from "./modules/reputation/portfolio-routes";
import {
  reviewAdminRoutes,
  reviewPublicRoutes,
  reviewSelfRoutes,
} from "./modules/reputation/routes";
import { resourceRoutes } from "./modules/resources/routes";
import {
  publicFlashOfferRoutes,
  rewardsAdminRoutes,
  rewardsClientRoutes,
} from "./modules/rewards/routes";
import { stampAdminRoutes, stampClientRoutes } from "./modules/rewards/stamp-routes";
import { serviceAdminRoutes } from "./modules/services/admin-routes";
import { servicesRoutes } from "./modules/services/routes";
import { settingsAdminRoutes } from "./modules/settings/admin-routes";
import { salonRoutes } from "./modules/settings/routes";
import { staffAdminRoutes } from "./modules/staff/admin-routes";
import { staffRoutes } from "./modules/staff/routes";
import { createSyncHub } from "./modules/sync/hub";
import { headSeq } from "./modules/sync/pull";
import { syncRoutes } from "./modules/sync/routes";
import { waitlistAdminRoutes, waitlistClientRoutes } from "./modules/waitlist/routes";
import { emailDeliveryRoutes } from "./notifications/email-routes";
import type { EmailProvider } from "./notifications/providers/types";
import { notificationAdminRoutes, optOutRoutes } from "./notifications/routes";
import { whatsappAdminRoutes, whatsappWebhookRoutes } from "./notifications/whatsapp/routes";
import { oauthAudit } from "./oauth/audit";
import { ensureOAuthSeeds } from "./oauth/clients";
import { oauthConsentScopePolicy } from "./oauth/consent";
import { desktopResource } from "./oauth/desktop";
import { createDesktopDevices } from "./oauth/desktop-devices";
import {
  type AppMetrics,
  createAppMetrics,
  registerRuntimeGauges,
} from "./observability/app-metrics";
import { requestContext } from "./observability/http";
import { type Logger, rootLogger } from "./observability/logger";
import { checkReady } from "./observability/ready";
import type { PaymentGateway } from "./payments/types";
import { createRateLimiter, rateLimit } from "./rate-limit";
import { bearerMatches, originCheck, securityHeaders } from "./security";

export interface AppDeps {
  /** Local immutable migration review; never enabled by the production entry point. */
  booksyConsultation?: BooksySourceReadModel;
  /** Local read-only review using the native candidate rows. */
  booksyNativePreview?: NonNullable<CalendarResponse["importSnapshot"]>;
  paymentGateway?: PaymentGateway | null;
  whatsappFetch?: typeof fetch;
  emailFetch?: typeof fetch;
  smsFetch?: typeof fetch;
  /** Disables manual provider tests in an isolated local instance. */
  disableProviderTests?: boolean;
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

const consultationAuthReads = new Set([
  "/api/auth/get-session",
  "/api/auth/jwks",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/public-client",
]);

const consultationAuthWrites = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
  "/api/auth/desktop/link",
  "/api/auth/desktop/token",
  "/api/auth/desktop/revoke",
]);

export function createApp(input: AppDeps): App {
  const metrics = input.metrics ?? createAppMetrics();
  const logger = input.logger ?? rootLogger;
  const deps: AppDeps = { ...input, metrics, logger };
  const consultation = Boolean(deps.booksyConsultation || deps.booksyNativePreview);
  registerRuntimeGauges(metrics, deps, { timeoutMs: input.readyTimeoutMs });
  const app = new Hono() as App;
  const auth = createAuth({ ...deps, emailProvider: consultation ? null : deps.emailProvider });
  const verifyDesktop = createTokenVerifier({
    auth,
    db: deps.db,
    config: deps.config,
    audience: desktopResource(deps.config.auth.baseURL),
  });
  const desktop = createDesktopDevices({
    ...deps,
    oauth: verifyDesktop,
    currentBrowserSession: async (headers) =>
      (await auth.api.getSession({ headers, query: { disableCookieCache: true } }))?.session.id,
    browserSession: (userId) =>
      auth.api.createDesktopBrowserSession({
        body: { userId },
        asResponse: true,
      }),
  });
  const authenticated = requireAuth(auth, deps.db, desktop.verifier);
  const limiter = createRateLimiter({
    storage: valkeySecondaryStorage(deps.valkey, deps.config.valkeyKeyPrefix),
    now: deps.rateLimitNow,
  });
  const { trustProxy, rateLimit: limits } = deps.config;
  const hub = createSyncHub({
    valkey: deps.valkey,
    keyPrefix: deps.config.valkeyKeyPrefix,
    readHead: () => headSeq(deps.db),
  });
  let draining = false;
  const readinessInstance = crypto.randomUUID();
  app.drain = () => {
    draining = true;
  };
  app.shutdown = async () => {
    await Promise.all([hub.close(), auth.mailer.stop()]);
  };
  app.ready = async () => {
    await ensureOAuthSeeds(deps.db, deps.config);
    if (!consultation) {
      // Check restored keys before serving traffic. Fresh installs keep lazy key creation
      // so parallel starts do not all try to create the first key.
      const [liveKey] = await deps.db
        .select({ id: jwks.id })
        .from(jwks)
        .where(or(isNull(jwks.expiresAt), gt(jwks.expiresAt, new Date())))
        .limit(1);
      if (liveKey) {
        try {
          // The probe has no user or permissions and never leaves this process.
          await auth.api.signJWT({
            body: {
              payload: { aud: "urn:citame:startup", exp: Math.floor(Date.now() / 1000) + 5 },
            },
          });
        } catch {
          throw new Error(
            "Cannot use the OAuth signing key. Check BETTER_AUTH_SECRET and the selected database.",
          );
        }
      }
    }
    auth.mailer.start();
  };

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
  if (consultation)
    app.use("*", async (c, next) => {
      const { method, path } = c.req;
      const authPath = path === "/api/auth" || path.startsWith("/api/auth/");
      // Better Auth also handles email verification on GET, which changes account data.
      const allowed =
        method === "OPTIONS" ||
        ((method === "GET" || method === "HEAD") &&
          (!authPath || consultationAuthReads.has(path))) ||
        (method === "POST" && consultationAuthWrites.has(path));
      if (!allowed)
        throw new DomainError(
          "forbidden",
          "Esta copia importada es de consulta. Booksy sigue siendo la agenda operativa.",
        );
      await next();
    });

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
    if (report.status === "ready" && c.req.header("x-citame-readiness-probe") === "instance")
      c.header("x-citame-api-instance", readinessInstance);
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

  app.route("/payments", redsysNotificationRoutes(deps));

  // Moderate limit for everything else, strict one for credential endpoints (brute force).
  // The global limiter fails open (a Valkey outage must not take public browsing down); the
  // auth limiter fails closed.
  const globalLimit = rateLimit({
    limiter,
    scope: "global",
    rule: limits.global,
    trustProxy,
    failOpen: true,
  });
  const pullNetworkLimit = rateLimit({
    limiter,
    scope: "sync-pull-network",
    rule: limits.syncPullNetwork,
    trustProxy,
    failOpen: true,
  });
  app.use("*", (c, next) => {
    const { method, path } = c.req;
    // Catch unauthenticated pulls too, without charging other routes on the shared network.
    if (path === "/sync/pull" && (method === "GET" || method === "HEAD")) {
      return pullNetworkLimit(c, next);
    }
    return globalLimit(c, next);
  });
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
  // The wildcard also matches the reset form POST at the base path.
  for (const path of [
    "/api/auth/request-password-reset",
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
  app.use("/api/auth/desktop/*", oauthLimit);
  // Browser-based MCP clients read metadata and talk to the token endpoint cross-origin. These
  // endpoints never rely on cookies (PKCE, bearer or anonymous), so a wildcard origin without
  // credentials is safe; cookie-bound endpoints (authorize, consent) get no CORS headers.
  const publicCorsOptions = {
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    maxAge: 600,
  };
  const publicCors = cors({ ...publicCorsOptions, origin: "*" });
  for (const path of [
    "/.well-known/*",
    "/api/auth/jwks",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/register",
    "/api/auth/oauth2/revoke",
  ]) {
    app.use(path, publicCors);
  }
  app.use("/api/auth/oauth2/consent", oauthConsentScopePolicy(auth, deps.db));
  app.use("/api/auth/oauth2/*", oauthAudit(auth, deps.db));

  // MCP server (Streamable HTTP, stateless) and its RFC 9728 protected-resource metadata. The
  // Browser MCP hosts use a dedicated allowlist independent of cookie-authenticated origins.
  const mcp = mcpRoutes(deps, auth);
  const mcpCors = cors({ ...publicCorsOptions, origin: mcp.allowedOrigins });
  for (const path of ["/mcp", "/mcp/*"]) {
    app.use(path, mcp.checkOrigin);
    app.use(path, mcpCors);
  }
  app.use("/mcp", rateLimit({ limiter, scope: "mcp", rule: limits.mcp, trustProxy }));
  app.route("/mcp", mcp.app);
  for (const path of ["/.well-known/oauth-protected-resource", new URL(mcp.metadataUrl).pathname]) {
    app.get(path, (c) => c.json(mcp.metadata(), 200, { "Cache-Control": "public, max-age=300" }));
  }

  app.route("/api/auth/desktop", desktop.routes);
  // Better Auth handles the remaining auth routes.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // RFC 8414: the issuer is `<origin>/api/auth`, so its metadata lives at the origin root with
  // the issuer path appended. Better Auth answers these itself (plugin `onRequest`).
  app.on(["GET", "HEAD"], "/.well-known/oauth-authorization-server/api/auth", (c) =>
    auth.handler(c.req.raw),
  );
  // Wildcard middleware covers both the base route and its subpaths.
  app.use("/me/*", authenticated);
  app.route("/notifications", optOutRoutes(deps));
  app.route("/whatsapp/webhook", whatsappWebhookRoutes(deps));
  app.route("/me", meRoutes(deps));
  app.route("/me", selfMarketingRoutes(deps));
  app.route("/marketing", marketingPublicRoutes(deps));
  app.route("/me", commerceClientRoutes(deps));
  app.route("/me", rewardsClientRoutes(deps));
  app.route("/me", stampClientRoutes(deps));
  app.route("/me/waitlist", waitlistClientRoutes(deps));
  app.route("/me/intake", intakeSelfRoutes(deps));
  app.route("/me/reviews", reviewSelfRoutes(deps));
  app.use("/intake/*", authenticated);
  app.route("/intake", intakeRoutes(deps));

  app.use("/admin/*", authenticated);
  app.route("/admin", adminRoutes(deps, auth));
  app.route("/admin/commerce", commerceAdminRoutes(deps));
  app.route("/admin/marketing", marketingAdminRoutes(deps, { deliveryTests: true }));
  app.route("/admin/peak-prices", peakPriceAdminRoutes(deps));
  app.route("/admin/clients", clientMarketingRoutes(deps));
  app.route("/admin/inventory", inventoryRoutes(deps));
  app.route("/admin/accounting", accountingRoutes(deps));
  app.route("/admin/rewards", rewardsAdminRoutes(deps));
  app.route("/admin/rewards/stamps", stampAdminRoutes(deps));
  const waitlistAdmin = waitlistAdminRoutes(deps);
  app.route("/admin/waitlist/desk", waitlistAdmin);
  app.route("/admin/waitlist", waitlistAdmin);
  app.route("/admin/resources", resourceRoutes(deps));
  app.route("/admin/reviews", reviewAdminRoutes(deps));
  app.route("/admin/portfolio", portfolioAdminRoutes(deps));
  app.route("/benefit-plans", publicPlanRoutes(deps));
  app.route("/gift-offers", publicGiftOfferRoutes(deps));
  app.route("/flash-offers", publicFlashOfferRoutes(deps));
  app.route("/admin/benefit-plans", planAdminRoutes(deps));
  app.route("/admin/passes", passRoutes(deps));
  app.route("/me/passes", passRoutes(deps));
  app.route("/admin/gift-cards", giftCardRoutes(deps));
  app.route("/me/gift-cards", giftCardRoutes(deps));
  app.route("/admin/services", serviceAdminRoutes(deps));
  app.route("/admin/staff", staffAdminRoutes(deps));
  app.route("/admin/clients", clientAdminRoutes(deps));
  app.route("/admin/clients", intakeClientRoutes(deps));
  app.route("/admin/intake-forms", intakeAdminRoutes(deps));
  app.route("/admin/reports", reportRoutes(deps));
  app.route("/admin/settings", settingsAdminRoutes(deps));
  app.route("/admin/notifications", notificationAdminRoutes(deps));
  app.route("/admin/email-delivery", emailDeliveryRoutes(deps, limiter));
  app.route("/admin/whatsapp", whatsappAdminRoutes(deps));

  // Public catalog and availability: anonymous visitors browse before they sign up.
  app.route("/salon", salonRoutes(deps));
  app.route("/reviews", reviewPublicRoutes(deps));
  app.route("/portfolio", portfolioPublicRoutes(deps));
  app.route("/services", servicesRoutes(deps));
  app.route("/staff", staffRoutes(deps));
  app.route("/availability", availabilityRoutes(deps));
  app.route("/availability/peak-price", peakPricePreviewRoute(deps, true));
  // Everything that touches appointments needs a session; the routes enforce the role policy.
  app.use("/appointments/*", authenticated);
  if (deps.booksyConsultation)
    app.route("/appointments", booksySourceRoutes(deps.db, deps.booksyConsultation));
  app.route("/appointments/peak-price", peakPricePreviewRoute(deps, false));
  app.route("/appointments", appointmentsRoutes(deps));

  app.use("/sync/*", authenticated);
  const streamLimit = rateLimit({
    limiter,
    scope: "sync-stream",
    rule: limits.syncStream,
    trustProxy,
    failOpen: true,
  });
  const pullAccountLimit = rateLimit<AppEnv>({
    limiter,
    scope: "sync-pull-account",
    rule: limits.syncPullAccount,
    failOpen: true,
    identity: (c) => c.get("principal").userId,
  });
  app.route("/sync", syncRoutes(deps, hub, { pullAccountLimit, streamLimit }, desktop.verifier));

  return app;
}
