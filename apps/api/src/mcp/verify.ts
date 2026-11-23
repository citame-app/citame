import { mcpScopeAllowedForRole, type OAuthScope, parseScopes } from "@sob/contracts";
import { type Database, oauthClient } from "@sob/db";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, type JSONWebKeySet, errors as joseErrors, jwtVerify } from "jose";
import type { Auth } from "../auth/auth";
import { loadPrincipal, type Principal } from "../auth/principal";
import type { AppConfig } from "../config";
import { currentOAuthGrant } from "../oauth/connections";

/** What a request authenticated with a valid access token carries into the tools. */
export interface McpIdentity {
  principal: Principal;
  scopes: OAuthScope[];
  clientId: string;
  grantId?: string;
  tokenId?: string;
}

/** Why a bearer token was refused. Maps to the RFC 6750 `error` parameter. */
export class BearerError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
    this.name = "BearerError";
  }
}

const KEY_SET_TTL_MS = 5 * 60_000;
/** Do not refetch the key set more often than this when a `kid` is unknown (forged tokens). */
export const DEFAULT_KEY_REFETCH_MS = 10_000;

export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<McpIdentity>;
}

/**
 * Validates bearer access tokens issued by this server (RFC 9068 JWT access tokens) for the
 * MCP resource:
 *
 * - signature against the server's own JWKS (ES256 only, `typ: at+jwt`),
 * - `iss` is this authorization server and `aud` is the MCP resource: a token minted for any
 *   other resource, or a plain session JWT, is refused (RFC 8707 / MCP spec: no token passthrough),
 * - `exp` with zero clock tolerance,
 * - the client still exists and is enabled, and the user's consent is still on file, so revoking
 *   a grant cuts access immediately instead of waiting for the access token to expire,
 * - the principal (role, profiles) is read from the database on every call, like the REST layer.
 */
export function createTokenVerifier(deps: {
  auth: Auth;
  db: Database;
  config: AppConfig;
  /** Minimum gap between key set refetches triggered by an unknown `kid`. */
  keyRefetchMs?: number;
  audience?: string;
}): TokenVerifier {
  const { auth, db, config, keyRefetchMs = DEFAULT_KEY_REFETCH_MS } = deps;
  const issuer = `${config.auth.baseURL.replace(/\/+$/, "")}/api/auth`;
  let keySet: ReturnType<typeof createLocalJWKSet> | null = null;
  let fetchedAt = 0;

  async function keys(force: boolean) {
    const now = Date.now();
    const stale = now - fetchedAt > KEY_SET_TTL_MS;
    const mayRefetch = now - fetchedAt >= keyRefetchMs;
    if (!keySet || stale || (force && mayRefetch)) {
      const jwks = (await auth.api.getJwks()) as JSONWebKeySet;
      keySet = createLocalJWKSet(jwks);
      fetchedAt = now;
    }
    return keySet;
  }

  async function verifyJwt(token: string) {
    const options = {
      issuer,
      audience: deps.audience ?? config.oauth.mcpResource,
      algorithms: ["ES256"],
      typ: "at+jwt",
      clockTolerance: 0,
      requiredClaims: ["exp", "iat", "sub", "aud"],
    };
    try {
      return (await jwtVerify(token, await keys(false), options)).payload;
    } catch (error) {
      // A key rotated in after the cache was filled: refetch once and retry.
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        return (await jwtVerify(token, await keys(true), options)).payload;
      }
      throw error;
    }
  }

  return {
    async verify(header) {
      const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
      if (!match?.[1]) throw new BearerError("invalid_request", "Missing bearer token");
      let payload: Awaited<ReturnType<typeof verifyJwt>>;
      try {
        payload = await verifyJwt(match[1]);
      } catch {
        // Deliberately one message: never tell a caller which check failed.
        throw new BearerError("invalid_token", "The access token is invalid or expired");
      }
      const userId = typeof payload.sub === "string" ? payload.sub : null;
      const clientId = typeof payload.azp === "string" ? payload.azp : null;
      if (!userId || !clientId || payload.cnf || typeof payload.scope !== "string") {
        throw new BearerError("invalid_token", "The access token is invalid or expired");
      }

      const [client] = await db
        .select({ disabled: oauthClient.disabled, scopes: oauthClient.scopes })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId));
      const consent = await currentOAuthGrant(db, clientId, userId);
      if (!client || client.disabled || !consent || payload.citame_grant !== consent.id) {
        throw new BearerError("invalid_token", "The access token is invalid or expired");
      }
      const principal = await loadPrincipal(db, userId);
      if (!principal)
        throw new BearerError("invalid_token", "The access token is invalid or expired");

      const scopes = parseScopes(payload.scope).filter(
        (scope) =>
          consent.scopes.includes(scope) &&
          (client.scopes?.includes(scope) ?? true) &&
          mcpScopeAllowedForRole(principal.role, scope),
      );
      return { principal, scopes, clientId, grantId: consent.id, tokenId: payload.jti };
    },
  };
}
