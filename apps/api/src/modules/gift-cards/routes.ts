import {
  giftCardCodeInputSchema,
  giftCardExpirySchema,
  giftCardPurchaseSchema,
  giftCardQuerySchema,
  giftCardReissueSchema,
  idSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { purchaseGift } from "./purchase";
import {
  authorizeGiftAccess,
  changeGiftExpiry,
  checkGift,
  getGift,
  giftHistory,
  listGifts,
  reissueGift,
  revealGift,
} from "./service";
export function giftCardRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      authorizeGiftAccess(c.get("principal"));
      c.header("Cache-Control", "private, no-store");
      if (
        c.get("desktopRequest") &&
        (c.req.method === "PATCH" ||
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
        await listGifts(deps.db, c.get("principal"), query.page, query.search, query.status),
      );
    })
    .post("/", async (c) =>
      c.json(
        await purchaseGift(
          deps.db,
          parseOrThrow(giftCardPurchaseSchema, await readJson(c)),
          c.get("principal"),
          deps.config.auth.secret,
        ),
        201,
      ),
    )
    .post("/check", async (c) =>
      c.json(
        await checkGift(
          deps.db,
          parseOrThrow(giftCardCodeInputSchema, await readJson(c)).code,
          c.get("principal"),
        ),
      ),
    )
    .get("/:id", async (c) =>
      c.json(await getGift(deps.db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal"))),
    )
    .get("/:id/movements", async (c) => {
      const query = parseOrThrow(giftCardQuerySchema, c.req.query());
      return c.json(
        await giftHistory(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          query.page,
        ),
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
