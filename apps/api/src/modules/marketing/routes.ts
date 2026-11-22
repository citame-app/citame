import {
  campaignCancelSchema,
  campaignCreateSchema,
  campaignQuerySchema,
  campaignQueueSchema,
  campaignUpdateSchema,
  idSchema,
  marketingConsentInputSchema,
  optOutRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { clientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import type { RateLimiter } from "../../rate-limit";
import { marketingCapabilities } from "./audience";
import { consentFor, setMarketingConsent, unsubscribeMarketing } from "./consent";
import {
  campaignDeliveries,
  cancelCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  previewCampaign,
  queueCampaign,
  updateCampaign,
} from "./service";
import { campaignTestEmailHandler } from "./test-email";
import { verifyMarketingOptOut } from "./tokens";

const id = (value: string) => parseOrThrow(idSchema, value);

export function marketingAdminRoutes(deps: AppDeps, limiter?: RateLimiter) {
  const now = deps.now ?? (() => new Date());
  const routes = new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "editCatalog");
      const generation = c.req.header("x-citame-generation");
      if (
        c.req.method !== "GET" &&
        (c.get("desktopRequest") || generation !== undefined) &&
        generation !== deps.config.syncReplicaGeneration
      )
        throw new DomainError(
          "sync_generation_changed",
          "Review the campaign on the restored server",
        );
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/capabilities", (c) => {
      const capabilities = marketingCapabilities(deps.config.notifications);
      return c.json({
        ...capabilities,
        canTestEmail:
          Boolean(limiter) &&
          capabilities.email &&
          !deps.disableEmailDeliveryTest &&
          c.get("principal").role === "owner",
      });
    })
    .get("/campaigns", async (c) =>
      c.json(
        await listCampaigns(
          deps.db,
          parseOrThrow(campaignQuerySchema, c.req.query()),
          c.get("principal"),
        ),
      ),
    )
    .post("/campaigns", async (c) =>
      c.json(
        await createCampaign(
          deps.db,
          parseOrThrow(campaignCreateSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/campaigns/:id", async (c) =>
      c.json(await getCampaign(deps.db, id(c.req.param("id")), c.get("principal"))),
    )
    .patch("/campaigns/:id", async (c) =>
      c.json(
        await updateCampaign(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(campaignUpdateSchema, await readJson(c)),
          c.get("principal"),
          c.req.header("x-citame-generation") !== undefined,
        ),
      ),
    )
    .get("/campaigns/:id/preview", async (c) =>
      c.json(
        await previewCampaign(
          deps.db,
          id(c.req.param("id")),
          c.get("principal"),
          deps.config.notifications,
          now(),
        ),
      ),
    )
    .post("/campaigns/:id/queue", async (c) =>
      c.json(
        await queueCampaign(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(campaignQueueSchema, await readJson(c)),
          c.get("principal"),
          deps.config.notifications,
          now(),
        ),
      ),
    )
    .post("/campaigns/:id/cancel", async (c) =>
      c.json(
        await cancelCampaign(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(campaignCancelSchema, await readJson(c)).version,
          c.get("principal"),
        ),
      ),
    )
    .get("/campaigns/:id/deliveries", async (c) =>
      c.json(
        await campaignDeliveries(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(campaignQuerySchema, c.req.query()),
          c.get("principal"),
        ),
      ),
    );
  if (limiter)
    routes.post(
      "/campaigns/:id/test-email",
      bodyLimit({ maxSize: 4096 }),
      campaignTestEmailHandler(deps, limiter),
    );
  return routes;
}
export function clientMarketingRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .get("/:id/marketing-consent", async (c) => {
      requirePermission(c.get("principal"), "clients");
      c.header("Cache-Control", "private, no-store");
      return c.json(await consentFor(deps.db, id(c.req.param("id"))));
    })
    .patch("/:id/marketing-consent", async (c) =>
      c.json(
        await setMarketingConsent(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(marketingConsentInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    );
}
export function selfMarketingRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .get("/marketing-consent", async (c) => {
      const p = c.get("principal");
      if (!p.clientId)
        throw new DomainError("forbidden", "Only clients have marketing preferences");
      c.header("Cache-Control", "private, no-store");
      return c.json(await consentFor(deps.db, p.clientId));
    })
    .patch("/marketing-consent", async (c) => {
      const p = c.get("principal");
      if (!p.clientId)
        throw new DomainError("forbidden", "Only clients have marketing preferences");
      return c.json(
        await setMarketingConsent(
          deps.db,
          p.clientId,
          parseOrThrow(marketingConsentInputSchema, await readJson(c)),
          p,
          true,
        ),
      );
    });
}
export function marketingPublicRoutes(deps: AppDeps) {
  const claims = (token: string) => {
    const value = verifyMarketingOptOut(deps.config.notifications.signingSecret, token);
    if (!value) throw new DomainError("validation_error", "This marketing opt-out link is invalid");
    return value;
  };
  return new Hono()
    .get("/opt-out", async (c) => {
      const value = claims(c.req.query("token") ?? "");
      await clientRoot(deps.db, value.clientId);
      c.header("Cache-Control", "private, no-store");
      return c.json({ channel: value.channel });
    })
    .post("/opt-out", async (c) => {
      const token =
        c.req.query("token") ?? parseOrThrow(optOutRequestSchema, await readJson(c)).token;
      const value = claims(token);
      return c.json(await unsubscribeMarketing(deps.db, value.clientId, value.channel));
    });
}
