import {
  applyRewardInputSchema,
  idSchema,
  loyaltyPolicyInputSchema,
  promotionInputSchema,
  rewardAdjustmentInputSchema,
  rewardChoiceSchema,
} from "@sob/contracts";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { requirePermission, requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { adjustRewards, getLoyaltyPolicy, loyaltyStatement, setLoyaltyPolicy } from "./accounts";
import { applyCheckoutReward, quoteCheckoutReward } from "./discounts";
import { listPromotions, savePromotion } from "./promotions";
import { returnCheckoutPoints } from "./value";

const pageSchema = z.coerce.number().int().min(1).max(100000).default(1);
function promotionGeneration(c: Context<AppEnv>, current: string) {
  const generation = c.req.header("x-citame-generation");
  if ((c.get("desktopRequest") || generation !== undefined) && generation !== current)
    throw new DomainError("sync_generation_changed", "Review promotions on the restored server");
  return generation !== undefined;
}
export function rewardsAdminRoutes({ db, config }: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "commerce");
      await next();
    })
    .get("/policy", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(await getLoyaltyPolicy(db));
    })
    .get("/promotions", async (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await listPromotions(
          db,
          c.get("principal"),
          parseOrThrow(pageSchema, c.req.query("page")),
          parseOrThrow(z.string().trim().max(100).default(""), c.req.query("search")),
        ),
      );
    })
    .post("/promotions", async (c) => {
      promotionGeneration(c, config.syncReplicaGeneration);
      return c.json(
        await savePromotion(
          db,
          null,
          parseOrThrow(promotionInputSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      );
    })
    .put("/promotions/:id", async (c) => {
      const allowIdenticalReplay = promotionGeneration(c, config.syncReplicaGeneration);
      return c.json(
        await savePromotion(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(promotionInputSchema, await readJson(c)),
          c.get("principal"),
          allowIdenticalReplay,
        ),
      );
    })
    .put("/policy", async (c) =>
      c.json(
        await setLoyaltyPolicy(
          db,
          parseOrThrow(loyaltyPolicyInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/clients/:id", async (c) =>
      c.json(
        await loyaltyStatement(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          parseOrThrow(pageSchema, c.req.query("page")),
        ),
      ),
    )
    .post("/clients/:id/adjustments", async (c) =>
      c.json(
        await adjustRewards(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(rewardAdjustmentInputSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    );
}
export function rewardsClientRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>().get("/rewards", async (c) => {
    const principal = c.get("principal");
    if (principal.role !== "client" || !principal.clientId)
      throw new DomainError("forbidden", "Customer account required");
    return c.json(
      await loyaltyStatement(
        db,
        principal.clientId,
        principal,
        parseOrThrow(pageSchema, c.req.query("page")),
      ),
    );
  });
}
/** Mounted beneath both existing receipt scopes; the common sale authorization still applies. */
export function checkoutRewardRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .post("/:id/reward/quote", async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const input = parseOrThrow(rewardChoiceSchema, await readJson(c));
      return c.json(
        await db.transaction((tx) => quoteCheckoutReward(tx, id, input, c.get("principal")), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }),
      );
    })
    .post("/:id/reward/return", async (c) => {
      requirePermission(c.get("principal"), "refunds");
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const input = parseOrThrow(
        z.object({ reason: z.string().trim().min(8).max(300) }).strict(),
        await readJson(c),
      );
      return c.json(
        await db.transaction((tx) =>
          returnCheckoutPoints(tx, id, input.reason, c.get("principal")),
        ),
      );
    })
    .post("/:id/reward", async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const input = parseOrThrow(applyRewardInputSchema, await readJson(c));
      return c.json(
        await db.transaction((tx) => applyCheckoutReward(tx, id, input, c.get("principal"))),
      );
    });
}
