import { mcpScopeAllowedForRole, parseScopes } from "@sob/contracts";
import { type Database, user } from "@sob/db";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Auth } from "../auth/auth";
import { readOAuthBody } from "./audit";

export function oauthConsentScopePolicy(auth: Auth, db: Database): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const input = await readOAuthBody(c.req.raw.clone());
    if (input.accept !== true && input.accept !== "true") return next();

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return next();

    const [account] = await db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, session.user.id));
    const rawScope =
      typeof input.scope === "string"
        ? input.scope
        : typeof input.oauth_query === "string"
          ? new URLSearchParams(input.oauth_query).get("scope")
          : null;
    if (rawScope === null) return next();
    if (
      !account ||
      parseScopes(rawScope).some((scope) => !mcpScopeAllowedForRole(account.role, scope))
    ) {
      return c.json(
        {
          error: "invalid_scope",
          error_description: "This account cannot grant one or more requested scopes",
        },
        400,
        { "Cache-Control": "no-store" },
      );
    }
    await next();
  };
}
