import { DESKTOP_CLIENT_ID, OAUTH_SCOPES } from "@sob/contracts";
import { type Database, oauthClient, oauthResource } from "@sob/db";
import type { AppConfig } from "../config";

/**
 * Seeds the rows the authorization server needs to exist: the protected resource (the MCP
 * endpoint, so the token audience is a known resource) and the first-party public clients that
 * cannot use dynamic registration because their id and redirect policy are fixed by the product.
 * Better Auth seeds `resources` itself at boot; repeating it here is idempotent and keeps a
 * database that was truncated (tests, restores) usable without a restart.
 *
 * The desktop app is a native public client: no secret, PKCE required, and a loopback redirect
 * (RFC 8252 section 7.3) where Better Auth lets the port vary at request time. Consent is
 * still required: a link that opens the authorize URL must never mint a code silently.
 */
export async function ensureOAuthSeeds(db: Database, config: AppConfig): Promise<void> {
  const now = new Date();
  await db
    .insert(oauthResource)
    .values({
      id: Bun.randomUUIDv7(),
      identifier: config.oauth.mcpResource,
      name: "Sisters of Beauty MCP server",
      allowedScopes: [...OAUTH_SCOPES],
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: oauthResource.identifier });
  await db
    .insert(oauthClient)
    .values({
      id: Bun.randomUUIDv7(),
      clientId: DESKTOP_CLIENT_ID,
      name: "Sisters of Beauty Desktop",
      redirectUris: ["http://127.0.0.1/callback"],
      scopes: [...OAUTH_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      requirePKCE: true,
      skipConsent: false,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: oauthClient.clientId });
}
