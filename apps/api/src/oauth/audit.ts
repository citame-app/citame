import { parseScopes } from "@sob/contracts";
import type { Database } from "@sob/db";
import type { MiddlewareHandler } from "hono";
import { decodeJwt } from "jose";
import { recordAudit } from "../audit";
import type { Auth } from "../auth/auth";
import { rootLogger } from "../observability/logger";

export async function readOAuthBody(request: {
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<Record<string, unknown>> {
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      return ((await request.json()) as Record<string, unknown>) ?? {};
    }
    return Object.fromEntries(new URLSearchParams(await request.text()));
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Audit trail of OAuth grants: consent decisions, client registrations, token issuance and
 * revocation. Metadata carries identifiers and scopes only, never codes or tokens
 * (`redactMetadata` is the safety net). A failure to write the record is logged and does not
 * turn an already completed protocol exchange into an error for the client.
 */
export function oauthAudit(auth: Auth, db: Database): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (c.req.method !== "POST") return next();
    const kind = path.endsWith("/oauth2/consent")
      ? "consent"
      : path.endsWith("/oauth2/register")
        ? "register"
        : path.endsWith("/oauth2/token")
          ? "token"
          : path.endsWith("/oauth2/revoke")
            ? "revoke"
            : null;
    if (!kind) return next();

    const request = c.req.raw.clone();
    await next();
    const response = c.res;
    if (response.status >= 300) return;
    try {
      const body = await readOAuthBody(request);
      if (kind === "consent") {
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        const query = new URLSearchParams(str(body.oauth_query) ?? "");
        const requested = str(body.scope) ?? query.get("scope");
        await recordAudit(db, {
          actorUserId: session?.user.id ?? null,
          action: body.accept === true ? "oauth.consent_grant" : "oauth.consent_deny",
          entity: "oauth_client",
          entityId: query.get("client_id"),
          metadata: { scopes: parseScopes(requested), resource: query.get("resource") },
        });
      } else if (kind === "register") {
        const registered = (await response.clone().json()) as Record<string, unknown>;
        await recordAudit(db, {
          actorUserId: null,
          action: "oauth.client_register",
          entity: "oauth_client",
          entityId: str(registered.client_id),
          metadata: {
            name: str(registered.client_name),
            redirectUris: registered.redirect_uris,
            scopes: parseScopes(str(registered.scope)),
          },
        });
      } else if (kind === "token") {
        const issued = (await response.clone().json()) as Record<string, unknown>;
        const access = str(issued.access_token);
        let claims: Record<string, unknown> = {};
        try {
          claims = access ? decodeJwt(access) : {};
        } catch {
          // Opaque token: no claims to record.
        }
        await recordAudit(db, {
          actorUserId: str(claims.sub),
          action: "oauth.token_issue",
          entity: "oauth_client",
          entityId: str(claims.azp) ?? str(body.client_id),
          metadata: {
            grantType: str(body.grant_type),
            scopes: parseScopes(str(issued.scope)),
            audience: claims.aud ?? null,
          },
        });
      } else {
        await recordAudit(db, {
          actorUserId: null,
          action: "oauth.token_revoke",
          entity: "oauth_client",
          entityId: str(body.client_id),
          metadata: {},
        });
      }
    } catch (error) {
      rootLogger.error("oauth audit failed", { err: error });
    }
  };
}
