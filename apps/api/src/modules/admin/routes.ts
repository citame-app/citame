import {
  type ChangeRoleResponse,
  changeRoleRequestSchema,
  createStaffAccountRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../../app";
import { assignRole, provisionStaffAccount } from "../../auth/accounts";
import type { Auth } from "../../auth/auth";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";

const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  requireRole(c.get("principal"), "owner");
  await next();
});

/** Owner-only account administration. Mounted behind `requireAuth`. */
export function adminRoutes(deps: AppDeps, auth: Auth) {
  const { db, now = () => new Date() } = deps;
  return (
    new Hono<AppEnv>()
      // Scoped to this router's own paths: a `use("*")` here would leak onto every other
      // router mounted under /admin.
      .use("/staff-accounts", ownerOnly)
      .use("/users/*", ownerOnly)
      .post("/staff-accounts", async (c) => {
        const body = parseOrThrow(createStaffAccountRequestSchema, await readJson(c));
        if (c.get("desktopRequest") && !body.existingCalendar)
          throw new DomainError("validation_error", "Review an existing calendar before linking");
        const response = await provisionStaffAccount(
          { auth, db },
          deps.config,
          body,
          c.get("principal").userId,
          c.req.raw,
        );
        return c.json(response, 201);
      })
      .patch("/users/:id/role", async (c) => {
        const principal = c.get("principal");
        const userId = c.req.param("id");
        const { role } = parseOrThrow(changeRoleRequestSchema, await readJson(c));
        if (userId === principal.userId) {
          throw new DomainError("forbidden", "You cannot change your own role");
        }
        const result = await assignRole(
          db,
          userId,
          role,
          { actorUserId: principal.userId },
          { now: now() },
        );
        const response: ChangeRoleResponse = result;
        return c.json(response);
      })
  );
}
