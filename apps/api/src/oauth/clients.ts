import { DESKTOP_CLIENT_ID, DESKTOP_SIGN_IN_SCOPE, MCP_SCOPES } from "@sob/contracts";
import { type Database, oauthClient, oauthClientResource, oauthResource } from "@sob/db";
import type { AppConfig } from "../config";
import { desktopResource } from "./desktop";

/**
 * Seeds the rows the authorization server needs to exist: the protected resource (the MCP
 * endpoint, so the token audience is a known resource) and the first-party public clients that
 * cannot use dynamic registration because their id and redirect policy are fixed by the product.
 * Better Auth also seeds its configured resources. The production entry point inserts them
 * first with ON CONFLICT, so concurrent API replicas never race the plugin's initializer.
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
      allowedScopes: [...MCP_SCOPES],
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oauthResource.identifier,
      set: { allowedScopes: [...MCP_SCOPES] },
    });
  const resource = desktopResource(config.auth.baseURL);
  await db
    .insert(oauthResource)
    .values({
      id: Bun.randomUUIDv7(),
      identifier: resource,
      name: "Citame Desktop",
      allowedScopes: [DESKTOP_SIGN_IN_SCOPE, "offline_access"],
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oauthResource.identifier,
      set: { allowedScopes: [DESKTOP_SIGN_IN_SCOPE, "offline_access"] },
    });
  await db
    .insert(oauthClient)
    .values({
      id: Bun.randomUUIDv7(),
      clientId: DESKTOP_CLIENT_ID,
      name: "Sisters of Beauty Desktop",
      redirectUris: ["http://127.0.0.1/callback"],
      scopes: [DESKTOP_SIGN_IN_SCOPE, "offline_access"],
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
    .onConflictDoUpdate({
      target: oauthClient.clientId,
      set: {
        scopes: [DESKTOP_SIGN_IN_SCOPE, "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        requirePKCE: true,
        skipConsent: false,
      },
    });
  await db
    .insert(oauthClientResource)
    .values({
      id: Bun.randomUUIDv7(),
      clientId: DESKTOP_CLIENT_ID,
      resourceId: resource,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [oauthClientResource.clientId, oauthClientResource.resourceId],
    });
}
