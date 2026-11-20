import {
  benefitPurchaseSchema,
  benefitRefundQuoteSchema,
  createBenefitPlanSchema,
  idempotencyKeySchema,
  idSchema,
  membershipCancelSchema,
  passQuerySchema,
  updateBenefitPlanSchema,
} from "@sob/contracts";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { recurringSettings } from "../../payments/recurring-settings";
import { RedsysGateway } from "../../payments/redsys";
import { createPlan, listPlans, updatePlan } from "./catalog";
import {
  authorizePass,
  cancelPass,
  getPass,
  listPasses,
  passView,
  purchasePass,
  renewPass,
  visiblePass,
} from "./service";
import { eligiblePasses, lockPeriod, refundQuote } from "./value";

const id = (value: string) => parseOrThrow(idSchema, value);
export function publicPlanRoutes(deps: AppDeps) {
  return new Hono().get("/", async (c) => c.json(await listPlans(deps.db)));
}
export function planAdminRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "editCatalog");
      await next();
    })
    .get("/", async (c) => c.json(await listPlans(deps.db, c.get("principal"))))
    .post("/", async (c) =>
      c.json(
        await createPlan(
          deps.db,
          parseOrThrow(createBenefitPlanSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .patch("/:id", async (c) =>
      c.json(
        await updatePlan(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(updateBenefitPlanSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    );
}
export function passRoutes(deps: AppDeps) {
  const gateway =
    deps.paymentGateway === undefined
      ? deps.config.payments.redsys
        ? new RedsysGateway(deps.config.payments.redsys)
        : null
      : deps.paymentGateway;
  const automaticAvailable = Boolean(recurringSettings(deps.config, gateway));
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      authorizePass(c.get("principal"));
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/", async (c) => {
      const q = parseOrThrow(passQuerySchema, c.req.query());
      return c.json(
        await listPasses(deps.db, c.get("principal"), q.page, q.search, q.clientId, q.kind),
      );
    })
    .post("/", async (c) =>
      c.json(
        await purchasePass(
          deps.db,
          parseOrThrow(benefitPurchaseSchema, await readJson(c)),
          c.get("principal"),
          automaticAvailable,
        ),
        201,
      ),
    )
    .get("/eligible", async (c) =>
      c.json(
        await deps.db.transaction(
          (tx) =>
            eligiblePasses(
              tx,
              parseOrThrow(idSchema, c.req.query("checkoutId")),
              c.get("principal"),
            ),
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
      ),
    )
    .post("/refund-quote", async (c) => {
      const p = c.get("principal");
      requirePermission(p, "refunds");
      const input = parseOrThrow(benefitRefundQuoteSchema, await readJson(c));
      return c.json(
        await deps.db.transaction(async (tx) => {
          const { contract } = await lockPeriod(tx, input.periodId);
          await visiblePass(tx, contract.id, p);
          return refundQuote(tx, input.periodId, input.paymentId, input.unitCount);
        }),
      );
    })
    .get("/:id", async (c) =>
      c.json(await getPass(deps.db, id(c.req.param("id")), c.get("principal"))),
    )
    .get("/:id/periods", async (c) => {
      const q = parseOrThrow(passQuerySchema, c.req.query());
      return c.json(
        await deps.db.transaction(
          async (tx) => {
            const row = await visiblePass(tx, id(c.req.param("id")), c.get("principal"));
            const view = await passView(tx, row, q.page);
            const count = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from pass_period where contract_id=${row.id}`,
            );
            return {
              periods: view.periods,
              pagination: { page: q.page, pageSize: 20, total: count[0]?.n ?? 0 },
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
      );
    })
    .post("/:id/renew", async (c) => {
      parseOrThrow(z.object({ idempotencyKey: idempotencyKeySchema }).strict(), await readJson(c));
      return c.json(await renewPass(deps.db, id(c.req.param("id")), c.get("principal")), 201);
    })
    .post("/:id/cancel", async (c) =>
      c.json(
        await cancelPass(
          deps.db,
          id(c.req.param("id")),
          parseOrThrow(membershipCancelSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    );
}
