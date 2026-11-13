import { account, clientProfile, type Database, session, user, verification } from "@sob/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { RedisClient } from "bun";
import type { AppConfig } from "../config";
import { valkeySecondaryStorage } from "./secondary-storage";

export interface AuthDeps {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
}

/**
 * The single Better Auth instance. Phase 6 adds the OAuth 2.1 provider / MCP plugin to this
 * same instance (same Drizzle adapter, same Valkey secondary storage), so nothing here is
 * specific to cookie-only auth: ids are stable strings, the secret is shared, and the
 * `role` field is server-owned.
 */
export function createAuth({ db, valkey, config }: AuthDeps) {
  return betterAuth({
    appName: "Sisters of Beauty",
    baseURL: config.auth.baseURL,
    secret: config.auth.secret,
    trustedOrigins: config.auth.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    secondaryStorage: valkeySecondaryStorage(valkey, config.valkeyKeyPrefix),
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
