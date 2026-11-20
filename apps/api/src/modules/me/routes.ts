import {
  type DesktopWorkspacesResponse,
  type MeResponse,
  updateProfileRequestSchema,
} from "@sob/contracts";
import { user } from "@sob/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import type { AppEnv, Principal } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { preferenceRoutes } from "../../notifications/routes";
import { oauthConnectionRoutes } from "../../oauth/connections";
import { desktopDeviceAccountRoutes } from "../../oauth/desktop-devices";
import { desktopWorkspaces } from "../../oauth/desktop-workspaces";
import { getPhone, updateProfile } from "./service";

export function meRoutes({ db }: Pick<AppDeps, "db">) {
  const respond = async (principal: Principal): Promise<MeResponse> => ({
    user: {
      id: principal.userId,
      email: principal.email,
      name: principal.name,
      role: principal.role,
    },
    staffId: principal.staffId,
    accessPreset: principal.role === "staff" ? (principal.accessPreset ?? "professional") : null,
    clientId: principal.clientId,
    phone: await getPhone(db, principal),
  });

  return new Hono<AppEnv>()
    .route("/connections", oauthConnectionRoutes(db))
    .route("/desktop-devices", desktopDeviceAccountRoutes(db))
    .route("/notification-preferences", preferenceRoutes({ db }))
    .get("/desktop-workspaces", (c) =>
      c.json<DesktopWorkspacesResponse>(
        { workspaces: desktopWorkspaces(c.get("principal")) },
        200,
        {
          "Cache-Control": "private, no-store",
        },
      ),
    )
    .get("/", async (c) => c.json(await respond(c.get("principal"))))
    .patch("/", async (c) => {
      const principal = c.get("principal");
      const request = parseOrThrow(updateProfileRequestSchema, await readJson(c));
      await updateProfile(db, principal, request);
      // Re-read the name so the response reflects what is stored, not what was sent.
      const [row] = await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, principal.userId));
      return c.json(await respond({ ...principal, name: row?.name ?? principal.name }));
    });
}
