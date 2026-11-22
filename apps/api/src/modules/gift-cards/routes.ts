import {
  type GiftReplicaPage,
  giftCardCodeInputSchema,
  giftCardExpirySchema,
  giftCardPurchaseSchema,
  giftCardQuerySchema,
  giftCardReissueSchema,
  giftOfferOrderSchema,
  giftOfferWriteSchema,
  giftReplicaQuerySchema,
  idSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { checkoutBankTenders, gatewayFor } from "../commerce/hosted-tenders";
import { giftOffers, publicGiftOffers, saveGiftOffer } from "./offers";
import { orderGiftOffer, purchaseGift } from "./purchase";
import {
  authorizeGiftAccess,
  changeGiftExpiry,
  checkGift,
  getGift,
  giftEligibleCatalog,
  giftHistory,
  giftReplicaPage,
  giftReplicaScope,
  listGifts,
  reissueGift,
  revealGift,
} from "./service";
export function giftCardRoutes(deps: AppDeps) {
  const gateway = gatewayFor(deps);
  const bankTenders = checkoutBankTenders(deps, gateway);
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      authorizeGiftAccess(c.get("principal"));
      c.header("Cache-Control", "private, no-store");
      if (
        c.get("desktopRequest") &&
        (c.req.method === "PATCH" ||
          c.req.method === "PUT" ||
          (c.req.method === "POST" && !/\/(?:check|code)$/.test(c.req.path))) &&
        c.req.header("x-citame-generation") !== deps.config.syncReplicaGeneration
      )
        throw new DomainError(
          "sync_generation_changed",
          "Review the gift card on the restored server",
        );
      await next();
    })
    .get("/", async (c) => {
      const query = parseOrThrow(giftCardQuerySchema, c.req.query());
      return c.json(
        await listGifts(
          deps.db,
          c.get("principal"),
          query.page,
          query.search,
          query.status,
          query.pendingOffer === "1",
        ),
      );
    })
    .post("/", async (c) => {
      const result = await purchaseGift(
        deps.db,
        parseOrThrow(giftCardPurchaseSchema, await readJson(c)),
        c.get("principal"),
        deps.config.auth.secret,
      );
      return c.json({ card: result.card, checkout: { ...result.checkout, ...bankTenders } }, 201);
    })
    .post("/storefront", async (c) => {
      const order = parseOrThrow(giftOfferOrderSchema, await readJson(c));
      const result = await orderGiftOffer(
        deps.db,
        order,
        c.get("principal"),
        deps.config.auth.secret,
        gateway !== null,
      );
      return c.json({ card: result.card, checkout: { ...result.checkout, ...bankTenders } }, 201);
    })
    .get("/offers", async (c) =>
      c.json(await giftOffers(deps.db, c.get("principal"), deps.config.syncReplicaGeneration)),
    )
    .put("/offers/:id", async (c) => {
      const input = parseOrThrow(giftOfferWriteSchema, await readJson(c));
      if (input.generation !== deps.config.syncReplicaGeneration)
        throw new DomainError(
          "sync_generation_changed",
          "Review gift templates on the restored server",
        );
      return c.json(
        await saveGiftOffer(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          input,
          c.get("principal"),
        ),
      );
    })
    .post("/check", async (c) =>
      c.json(
        await checkGift(
          deps.db,
          parseOrThrow(giftCardCodeInputSchema, await readJson(c)).code,
          c.get("principal"),
        ),
      ),
    )
    .get("/eligible-services", async (c) => {
      requirePermission(c.get("principal"), "commerce");
      return c.json(await giftEligibleCatalog(deps.db));
    })
    .get("/replica", async (c) => {
      const query = parseOrThrow(giftReplicaQuerySchema, c.req.query());
      return c.json({
        ...(await giftReplicaPage(deps.db, c.get("principal"), query.page)),
        generation: deps.config.syncReplicaGeneration,
      } satisfies GiftReplicaPage);
    })
    .get("/:id", async (c) =>
      c.json(await getGift(deps.db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal"))),
    )
    .get("/:id/movements", async (c) => {
      const query = parseOrThrow(giftCardQuerySchema, c.req.query());
      const principal = c.get("principal");
      const history = await giftHistory(
        deps.db,
        parseOrThrow(idSchema, c.req.param("id")),
        principal,
        query.page,
      );
      const scope = giftReplicaScope(principal);
      return c.json(
        scope
          ? {
              ...history,
              replica: { scope, generation: deps.config.syncReplicaGeneration },
            }
          : history,
      );
    })
    .post("/:id/code", async (c) =>
      c.json(
        await revealGift(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          deps.config.auth.secret,
        ),
      ),
    )
    .patch("/:id/expiry", async (c) => {
      requirePermission(c.get("principal"), "refunds");
      return c.json(
        await changeGiftExpiry(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(giftCardExpirySchema, await readJson(c)),
          c.get("principal"),
        ),
      );
    })
    .post("/:id/reissue", async (c) => {
      requirePermission(c.get("principal"), "refunds");
      return c.json(
        await reissueGift(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(giftCardReissueSchema, await readJson(c)),
          c.get("principal"),
          deps.config.auth.secret,
        ),
      );
    });
}

export function publicGiftOfferRoutes(deps: AppDeps) {
  const paymentsAvailable = gatewayFor(deps) !== null;
  return new Hono<AppEnv>().get("/", async (c) =>
    c.json(await publicGiftOffers(deps.db, paymentsAvailable), 200, {
      "Cache-Control": "no-store",
    }),
  );
}
