import {
  type ChangeRoleResponse,
  changeRoleRequestSchema,
  createStaffAccountRequestSchema,
  type StaffAccountResponse,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { assignRole, createAccount } from "../../auth/accounts";
import type { Auth } from "../../auth/auth";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";

/** Owner-only account administration. Mounted behind `requireAuth`. */
export function adminRoutes({ db }: AppDeps, auth: Auth) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner");
      await next();
    })
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
      const response: StaffAccountResponse = {
        userId: created.userId,
        staffId: created.staffId,
        email: body.email.trim().toLowerCase(),
        role: "staff",
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
      const result = await assignRole(db, userId, role, { actorUserId: principal.userId });
      const response: ChangeRoleResponse = result;
      return c.json(response);
    });
}
