import { oauthProvider } from "@better-auth/oauth-provider";
import { OAUTH_SCOPES } from "@sob/contracts";
import {
  account,
  clientProfile,
  type Database,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  user,
  verification,
} from "@sob/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import type { RedisClient } from "bun";
import type { AppConfig } from "../config";
import { valkeySecondaryStorage } from "./secondary-storage";

export interface AuthDeps {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
}

/**
 * The single Better Auth instance: email/password sessions for the web app plus, since Phase 6,
 * the OAuth 2.1 authorization server (`oauthProvider()` with the `jwt()` plugin) used by MCP
 * clients and the desktop app. Same Drizzle adapter, same Valkey secondary storage, same
 * secret. ADR 0009 explains why `oauthProvider()` and not the `mcp()` plugin.
 */
export function createAuth({ db, valkey, config }: AuthDeps) {
  return betterAuth({
    appName: "Sisters of Beauty",
    baseURL: config.auth.baseURL,
    secret: config.auth.secret,
    trustedOrigins: config.auth.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
        jwks,
        oauthClient,
        oauthResource,
        oauthClientResource,
        oauthAccessToken,
        oauthRefreshToken,
        oauthConsent,
        oauthClientAssertion,
      },
    }),
    secondaryStorage: valkeySecondaryStorage(valkey, config.valkeyKeyPrefix),
    // Required by the OAuth provider: refresh tokens reference the session that granted them.
    // Sessions are still served from Valkey; Postgres only holds the durable copy.
    session: { storeSessionInDatabase: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "client",
          // Server-owned: never accepted from sign-up or update-user input.
          input: false,
        },
      },
    },
    plugins: [
      // Signs the JWT access tokens (ES256). Keys live in the `jwks` table, private half encrypted.
      jwt({ jwks: { keyPairConfig: { alg: "ES256" } } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...OAUTH_SCOPES],
        // No client_credentials: every token belongs to a signed-in user, there are no
        // machine clients. Authorization code (PKCE is mandatory) and refresh only.
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: config.oauth.accessTokenTtlSeconds,
        refreshTokenExpiresIn: config.oauth.refreshTokenTtlSeconds,
        // RFC 7591 for MCP clients, anonymous because they cannot hold credentials beforehand.
        // Registered clients are public (PKCE) and get no capability beyond the catalogue.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationDefaultScopes: ["mcp:read", "mcp:book", "offline_access"],
        clientRegistrationAllowedScopes: ["schedule:read"],
        resources: [
          {
            identifier: config.oauth.mcpResource,
            name: "Sisters of Beauty MCP server",
            allowedScopes: [...OAUTH_SCOPES],
          },
        ],
        clientRegistrationDefaultResources: [config.oauth.mcpResource],
        enforcePerClientResources: true,
        // Our Valkey limiter fronts these endpoints (app.ts); the plugin's own limiter is off.
        rateLimit: {
          token: false,
          authorize: false,
          introspect: false,
          revoke: false,
          register: false,
          rotateClientKeys: false,
          userinfo: false,
        },
      }),
    ],
    // Rate limiting is done by our own Valkey limiter in front of the router (src/rate-limit.ts).
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: config.auth.secureCookies,
      // Explicit so the checks stay on under NODE_ENV=test (Better Auth disables them there).
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      database: { generateId: () => Bun.randomUUIDv7() },
    },
    databaseHooks: {
      user: {
        create: {
          // Every self-service sign-up is a client and gets a booking profile.
          after: async (created) => {
            const role = (created as { role?: string }).role ?? "client";
            if (role !== "client") return;
            await db
              .insert(clientProfile)
              .values({ name: created.name, email: created.email, userId: created.id })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
