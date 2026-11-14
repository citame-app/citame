import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://sob:sob@localhost:5432/sob"),
  VALKEY_URL: z.string().min(1).default("redis://localhost:6379"),
  /** Prefix for every Valkey key, so several environments (or test runs) can share a server. */
  VALKEY_KEY_PREFIX: z.string().default("sob:"),
  PORT: positiveInt.default(3000),
  NODE_ENV: z.string().optional(),

  /** Better Auth signing/encryption secret. 32+ characters; generate with `openssl rand -base64 32`. */
  BETTER_AUTH_SECRET: z
    .string({ error: "BETTER_AUTH_SECRET is required" })
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** Public base URL of the API (used for cookies, callbacks and origin checks). */
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  /** Comma-separated origins allowed to call the auth endpoints from a browser (the web app). */
  TRUSTED_ORIGINS: z.string().default(""),

  /** Trust `X-Forwarded-For` for the client IP. Enable only behind a reverse proxy you control. */
  TRUST_PROXY: z.stringbool().default(false),
  RATE_LIMIT_GLOBAL_MAX: positiveInt.default(300),
  RATE_LIMIT_GLOBAL_WINDOW_SECONDS: positiveInt.default(60),
  RATE_LIMIT_AUTH_MAX: positiveInt.default(10),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: positiveInt.default(60),
  /** New SSE connections per caller and window: reconnect storms must not exhaust the server. */
  SYNC_STREAM_RATE_LIMIT_MAX: positiveInt.default(30),
  SYNC_STREAM_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),

  /**
   * Public URL of the MCP endpoint, which is also the OAuth resource (RFC 8707) and the token
   * audience. Defaults to `<BETTER_AUTH_URL>/mcp`: the web app's origin, forwarded to the API.
   */
  MCP_RESOURCE_URL: z.url().optional(),
  /** Lifetime of OAuth access tokens. Short on purpose: JWTs cannot be revoked before expiry. */
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt.default(900),
  /** Lifetime of OAuth refresh tokens (rotated on every use). */
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: positiveInt.default(14 * 24 * 60 * 60),
  /** Token, authorize, consent, revoke and introspection calls per caller and window. */
  RATE_LIMIT_OAUTH_MAX: positiveInt.default(60),
  RATE_LIMIT_OAUTH_WINDOW_SECONDS: positiveInt.default(60),
  /** Anonymous dynamic client registrations per caller and window. */
  RATE_LIMIT_OAUTH_REGISTER_MAX: positiveInt.default(10),
  RATE_LIMIT_OAUTH_REGISTER_WINDOW_SECONDS: positiveInt.default(60),
  /** MCP requests per caller and window. */
  RATE_LIMIT_MCP_MAX: positiveInt.default(120),
  RATE_LIMIT_MCP_WINDOW_SECONDS: positiveInt.default(60),
});

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

export interface AppConfig {
  databaseUrl: string;
  valkeyUrl: string;
  valkeyKeyPrefix: string;
  port: number;
  auth: {
    secret: string;
    baseURL: string;
    trustedOrigins: string[];
    /** Cookies carry the Secure attribute over https and in production. */
    secureCookies: boolean;
  };
  oauth: {
    /** Resource identifier and audience of every access token this API accepts at `/mcp`. */
    mcpResource: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  trustProxy: boolean;
  rateLimit: {
    global: RateLimitRule;
    auth: RateLimitRule;
    syncStream: RateLimitRule;
    oauth: RateLimitRule;
    oauthRegister: RateLimitRule;
    mcp: RateLimitRule;
  };
}

/** Parses and validates the environment once, failing fast with every problem listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    valkeyUrl: e.VALKEY_URL,
    valkeyKeyPrefix: e.VALKEY_KEY_PREFIX,
    port: e.PORT,
    auth: {
      secret: e.BETTER_AUTH_SECRET,
      baseURL: e.BETTER_AUTH_URL,
      trustedOrigins: e.TRUSTED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      secureCookies: e.NODE_ENV === "production" || e.BETTER_AUTH_URL.startsWith("https://"),
    },
    oauth: {
      mcpResource: e.MCP_RESOURCE_URL ?? `${e.BETTER_AUTH_URL.replace(/\/+$/, "")}/mcp`,
      accessTokenTtlSeconds: e.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: e.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    },
    trustProxy: e.TRUST_PROXY,
    rateLimit: {
      global: { max: e.RATE_LIMIT_GLOBAL_MAX, windowSeconds: e.RATE_LIMIT_GLOBAL_WINDOW_SECONDS },
      auth: { max: e.RATE_LIMIT_AUTH_MAX, windowSeconds: e.RATE_LIMIT_AUTH_WINDOW_SECONDS },
      syncStream: {
        max: e.SYNC_STREAM_RATE_LIMIT_MAX,
        windowSeconds: e.SYNC_STREAM_RATE_LIMIT_WINDOW_SECONDS,
      },
      oauth: { max: e.RATE_LIMIT_OAUTH_MAX, windowSeconds: e.RATE_LIMIT_OAUTH_WINDOW_SECONDS },
      oauthRegister: {
        max: e.RATE_LIMIT_OAUTH_REGISTER_MAX,
        windowSeconds: e.RATE_LIMIT_OAUTH_REGISTER_WINDOW_SECONDS,
      },
      mcp: { max: e.RATE_LIMIT_MCP_MAX, windowSeconds: e.RATE_LIMIT_MCP_WINDOW_SECONDS },
    },
  };
}
