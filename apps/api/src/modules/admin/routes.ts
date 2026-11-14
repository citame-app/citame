import {
  type ChangeRoleResponse,
  changeRoleRequestSchema,
  createStaffAccountRequestSchema,
  type StaffAccountResponse,
} from "@sob/contracts";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../../app";
import { assignRole, createAccount, sendInvitation } from "../../auth/accounts";
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
        const created = await createAccount(
          { auth, db },
          {
            email: body.email,
            name: body.name,
            password: body.password,
            displayName: body.displayName,
            role: "staff",
          },
          { actorUserId: c.get("principal").userId, action: "staff.create" },
        );
        if (!created.staffId) throw new Error("Staff account was created without a calendar");
        const email = body.email.trim().toLowerCase();
        if (created.invited) {
          await sendInvitation(auth, deps.config, { userId: created.userId, email }, c.req.raw);
        }
        const response: StaffAccountResponse = {
          userId: created.userId,
          staffId: created.staffId,
          email,
          role: "staff",
          invited: created.invited,
        };
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
