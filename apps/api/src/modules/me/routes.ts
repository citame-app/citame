import type { MeResponse } from "@sob/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/principal";

export function meRoutes() {
  return new Hono<AppEnv>().get("/", (c) => {
    const p = c.get("principal");
    const body: MeResponse = {
      user: { id: p.userId, email: p.email, name: p.name, role: p.role },
      staffId: p.staffId,
      clientId: p.clientId,
    };
    return c.json(body);
  });
}
