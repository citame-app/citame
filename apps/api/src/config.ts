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
  trustProxy: boolean;
  rateLimit: { global: RateLimitRule; auth: RateLimitRule };
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
    trustProxy: e.TRUST_PROXY,
    rateLimit: {
      global: { max: e.RATE_LIMIT_GLOBAL_MAX, windowSeconds: e.RATE_LIMIT_GLOBAL_WINDOW_SECONDS },
      auth: { max: e.RATE_LIMIT_AUTH_MAX, windowSeconds: e.RATE_LIMIT_AUTH_WINDOW_SECONDS },
    },
  };
}
