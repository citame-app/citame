import { oauthProvider } from "@better-auth/oauth-provider";
import {
  DESKTOP_SIGN_IN_SCOPE,
  MCP_MANAGEMENT_SCOPES,
  MCP_SCOPES,
  mcpScopeAllowedForRole,
  OAUTH_SCOPES,
  parseScopes,
} from "@sob/contracts";
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
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type { RedisClient } from "bun";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config";
import { localeFromRequest } from "../notifications/auth-emails";
import type { EmailProvider } from "../notifications/providers/types";
import { currentOAuthGrant } from "../oauth/connections";
import { desktopResource } from "../oauth/desktop";
import { bindMcpCodeToGrant, invalidMcpGrant } from "../oauth/grant-binding";
import { type Logger, rootLogger } from "../observability/logger";
import { desktopBrowserSession } from "./desktop-browser-session";
import { type AuthMailer, createAuthMailer } from "./mailer";
import { valkeySecondaryStorage, withStaffInvitations } from "./secondary-storage";

export interface AuthDeps {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
  /** Sends account emails (verification, reset, invitation). Null: they are logged as skipped. */
  emailProvider?: EmailProvider | null;
  logger?: Logger;
  /** Read-only preflight disables the provider's OAuth resource provisioning. */
  seedOAuthResources?: boolean;
}

/** Lifetime of the emailed links, in seconds. Reset and verification are short; invitations longer. */
export const VERIFY_LINK_SECONDS = 60 * 60;
export const RESET_LINK_SECONDS = 60 * 60;
export const INVITE_LINK_SECONDS = 72 * 60 * 60;
export const OAUTH_JWKS_GRACE_SECONDS = 30 * 24 * 60 * 60;

const tokenDigest = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex").slice(0, 24);

/**
 * The single Better Auth instance: email/password sessions for the web app plus, since Phase 6,
 * the OAuth 2.1 authorization server (`oauthProvider()` with the `jwt()` plugin) used by MCP
 * clients and the desktop app. Same Drizzle adapter, same Valkey secondary storage, same
 * secret. ADR 0009 explains why `oauthProvider()` and not the `mcp()` plugin.
 */
export function createAuth({
  db,
  valkey,
  config,
  emailProvider = null,
  logger,
  seedOAuthResources = true,
}: AuthDeps) {
  const log = logger ?? rootLogger;
  const mailer: AuthMailer = createAuthMailer({
    provider: emailProvider,
    db,
    secret: config.notifications.signingSecret,
    config: config.notifications,
    logger: log,
  });
  const defaultLocale = config.notifications.defaultLocale;
  const auth = betterAuth({
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
    secondaryStorage: withStaffInvitations(
      db,
      valkeySecondaryStorage(valkey, config.valkeyKeyPrefix),
    ),
    // Required by the OAuth provider: refresh tokens reference the session that granted them.
    // Sessions are still served from Valkey; Postgres only holds the durable copy.
    session: { storeSessionInDatabase: true },
    // Better Auth's own console output is plain text with colours; route it through the JSON
    // logger (which also scrubs addresses and tokens) so every log line has one shape.
    logger: {
      level: "warn",
      log: (level, message, ...args) => {
        const fields = args.length > 0 ? { detail: args } : undefined;
        if (level === "error") log.error(`better-auth: ${message}`, fields);
        else log.warn(`better-auth: ${message}`, fields);
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      // Clients prove they own the address before they get a session (and so before they book).
      // Better Auth then also answers a duplicate sign-up like a fresh one (no enumeration).
      requireEmailVerification: config.auth.requireEmailVerification,
      resetPasswordTokenExpiresIn: RESET_LINK_SECONDS,
      // A reset is usually "someone else may have my password": end every existing session.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user: target, url, token }, request) => {
        await mailer.send({
          kind: "reset_password",
          to: target.email,
          url,
          locale: localeFromRequest(request, defaultLocale),
          expiresInMinutes: RESET_LINK_SECONDS / 60,
          idempotencyKey: `reset_password:${tokenDigest(token)}`,
        });
      },
      // Following a reset link proves control of the mailbox, which is what verification is.
      onPasswordReset: async ({ user: target }) => {
        await db.update(user).set({ emailVerified: true }).where(eq(user.id, target.id));
      },
      onExistingUserSignUp: async ({ user: target }, request) => {
        await mailer.send({
          kind: "account_exists",
          to: target.email,
          url: `${config.notifications.publicUrl}/reset-password`,
          locale: localeFromRequest(request, defaultLocale),
          expiresInMinutes: RESET_LINK_SECONDS / 60,
          idempotencyKey: `account_exists:${Bun.randomUUIDv7()}`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // An unverified person who signs in gets a fresh link instead of a dead end.
      sendOnSignIn: true,
      // The emailed link also signs the person in, so booking can continue where it stopped.
      autoSignInAfterVerification: true,
      expiresIn: VERIFY_LINK_SECONDS,
      sendVerificationEmail: async ({ user: target, url, token }, request) => {
        await mailer.send({
          kind: "verify_email",
          to: target.email,
          url,
          locale: localeFromRequest(request, defaultLocale),
          expiresInMinutes: VERIFY_LINK_SECONDS / 60,
          idempotencyKey: `verify_email:${tokenDigest(token)}`,
        });
      },
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
      desktopBrowserSession,
      // Signs the JWT access tokens (ES256). Keys live in the `jwks` table, private half encrypted.
      jwt({ jwks: { keyPairConfig: { alg: "ES256" }, gracePeriod: OAUTH_JWKS_GRACE_SECONDS } }),
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
        // Public and confidential clients require PKCE and can request only known scopes.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationDefaultScopes: ["mcp:read", "mcp:book", "offline_access"],
        clientRegistrationAllowedScopes: ["schedule:read", ...MCP_MANAGEMENT_SCOPES],
        resources: seedOAuthResources
          ? [
              {
                identifier: config.oauth.mcpResource,
                name: "Sisters of Beauty MCP server",
                allowedScopes: [...MCP_SCOPES],
              },
              {
                identifier: desktopResource(config.auth.baseURL),
                name: "Citame Desktop",
                allowedScopes: [DESKTOP_SIGN_IN_SCOPE, "offline_access"],
              },
            ]
          : [],
        extensions: [
          {
            claims: {
              accessToken: async ({ client, user: account, resources, scopes, referenceId }) => {
                if (!account) return {};
                const desktop =
                  client.clientId === "sob-desktop" &&
                  resources?.includes(desktopResource(config.auth.baseURL));
                if (!desktop && !resources?.includes(config.oauth.mcpResource)) return {};
                if (desktop && resources?.length !== 1) return {};
                const [current] = await db
                  .select({ role: user.role })
                  .from(user)
                  .where(eq(user.id, account.id));
                if (
                  !current ||
                  parseScopes(scopes.join(" ")).some(
                    (scope) => !mcpScopeAllowedForRole(current.role, scope),
                  )
                ) {
                  throw new APIError("BAD_REQUEST", {
                    error: "invalid_scope",
                    error_description: "This account cannot grant one or more requested scopes",
                  });
                }
                const grant = await currentOAuthGrant(db, client.clientId, account.id);
                if (!desktop && (!grant || referenceId !== grant.id)) throw invalidMcpGrant();
                return { citame_grant: grant?.id ?? null };
              },
            },
          },
        ],
        clientRegistrationDefaultResources: seedOAuthResources ? [config.oauth.mcpResource] : [],
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
      cookiePrefix: config.auth.cookiePrefix,
      useSecureCookies: config.auth.secureCookies,
      // Explicit so the checks stay on under NODE_ENV=test (Better Auth disables them there).
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      database: { generateId: () => Bun.randomUUIDv7() },
    },
    databaseHooks: {
      verification: {
        create: {
          before: async (record) => {
            const value = await bindMcpCodeToGrant(db, record.value, config.oauth.mcpResource);
            if (value !== record.value) return { data: { ...record, value } };
          },
        },
      },
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
  return Object.assign(auth, { mailer });
}

export type Auth = ReturnType<typeof createAuth>;
