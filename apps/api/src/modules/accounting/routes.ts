import {
  type CommissionScope,
  commissionPayoutInputSchema,
  commissionPolicyInputSchema,
  idSchema,
  permissionsFor,
  reportQuerySchema,
  reviewedCommissionPayoutInputSchema,
  reviewedCommissionRateInputSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import {
  commissionStatement,
  findRecordedPayout,
  getPolicy,
  recordPayout,
  salesReport,
  setPolicy,
} from "./service";

const pages = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  payoutPage: z.coerce.number().int().min(1).max(100000).default(1),
});
export function accountingRoutes(deps: AppDeps) {
  const generation = deps.config.syncReplicaGeneration;
  const checkGeneration = (reviewed: string) => {
    if (reviewed !== generation)
      throw new DomainError("sync_generation_changed", "The database changed since review");
  };
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "commerce");
      if (c.req.method !== "GET") requirePermission(c.get("principal"), "manageCommissions");
      await next();
    })
    .get("/statement-scope", (c) => {
      const principal = c.get("principal");
      const permissions = permissionsFor(principal.role, principal.accessPreset);
      return c.json<CommissionScope>(
        {
          staffId: principal.staffId,
          canChooseStaff: permissions.financialReports,
          canManage: permissions.manageCommissions,
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
    })
    .get("/staff/:id/policy", async (c) =>
      c.json(
        await getPolicy(deps.db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      ),
    )
    .get("/staff/:id/policy/reviewed", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "manageCommissions");
      const policy = await getPolicy(deps.db, parseOrThrow(idSchema, c.req.param("id")), principal);
      return c.json({ ...policy, generation }, 200, { "Cache-Control": "private, no-store" });
    })
    .put("/staff/:id/policy/reviewed", async (c) => {
      const { generation: reviewed, ...input } = parseOrThrow(
        reviewedCommissionRateInputSchema,
        await readJson(c),
      );
      checkGeneration(reviewed);
      const policy = await setPolicy(
        deps.db,
        parseOrThrow(idSchema, c.req.param("id")),
        input,
        c.get("principal"),
      );
      return c.json({ ...policy, generation }, 200, { "Cache-Control": "private, no-store" });
    })
    .post("/staff/:id/payouts/reviewed", async (c) => {
      const principal = c.get("principal");
      const {
        generation: reviewed,
        actorUserId,
        existingPayoutId,
        ...input
      } = parseOrThrow(reviewedCommissionPayoutInputSchema, await readJson(c));
      if (principal.userId !== actorUserId)
        throw new DomainError(
          "forbidden",
          "Only the account that reviewed this payout can record it",
        );
      checkGeneration(reviewed);
      const staffId = parseOrThrow(idSchema, c.req.param("id"));
      const payout = existingPayoutId
        ? await findRecordedPayout(deps.db, staffId, existingPayoutId, input, principal)
        : await recordPayout(deps.db, staffId, input, principal, true);
      return c.json(
        { ...payout, idempotencyKey: input.idempotencyKey },
        existingPayoutId ? 200 : 201,
        {
          "Cache-Control": "private, no-store",
        },
      );
    })
    .put("/staff/:id/policy", async (c) =>
      c.json(
        await setPolicy(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(commissionPolicyInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/staff/:id/statement", async (c) => {
      const query = parseOrThrow(pages, c.req.query());
      c.header("Cache-Control", "private, no-store");
      return c.json({
        ...(await commissionStatement(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          query.page,
          query.payoutPage,
        )),
        generation,
      });
    })
    .post("/staff/:id/payouts", async (c) =>
      c.json(
        await recordPayout(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(commissionPayoutInputSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/sales", async (c) => {
      requirePermission(c.get("principal"), "financialReports");
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await salesReport(
          deps.db,
          parseOrThrow(reportQuerySchema, c.req.query()),
          c.get("principal"),
        ),
      );
    });
}
