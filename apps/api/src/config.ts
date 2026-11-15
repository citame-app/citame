import { readFileSync } from "node:fs";
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://sob:sob@localhost:5432/sob"),
  VALKEY_URL: z.string().min(1).default("redis://localhost:6379"),
  /** Prefix for every Valkey key, so several environments (or test runs) can share a server. */
  VALKEY_KEY_PREFIX: z.string().default("sob:"),
  PORT: positiveInt.default(3000),
  /**
   * Seconds a connection may idle before the listener closes it (Bun's own default is 10, below the
   * 15 s SSE heartbeat; `/sync/stream` is exempt either way). 0 disables, 255 is Bun's maximum.
   */
  HTTP_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(255).default(30),
  /** Largest request body in bytes; bigger ones are answered 413. Default 1 MiB. */
  HTTP_MAX_BODY_BYTES: positiveInt.default(1_048_576),
  NODE_ENV: z.string().optional(),

  /** Better Auth signing/encryption secret. 32+ characters; generate with `openssl rand -base64 32`. */
  BETTER_AUTH_SECRET: z
    .string({ error: "BETTER_AUTH_SECRET is required" })
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** Public base URL of the API (used for cookies, callbacks and origin checks). */
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  /**
   * Clients must confirm their email address before they can sign in (and so before they can
   * book). On by default; turning it off is for local development without a mail server.
   */
  AUTH_REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(true),
  /** Comma-separated origins allowed to call the auth endpoints from a browser (the web app). */
  TRUSTED_ORIGINS: z.string().default(""),

  /**
   * Bearer token Prometheus presents to `/metrics`. Unset: `/metrics` answers only requests that
   * did not come through the public proxy (internal network scrape). Min 16 characters.
   */
  METRICS_TOKEN: z.union([z.string().min(16), z.literal("").transform(() => undefined)]).optional(),

  /**
   * On SIGTERM `/ready` answers 503 for this long before the listener closes, so the load
   * balancer drains the instance first. Keep it below the orchestrator's kill timeout.
   */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(0),

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
  MCP_RESOURCE_URL: z.union([z.url(), z.literal("").transform(() => undefined)]).optional(),
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

  /** Runs the notification worker inside the API process (see also `bun run worker`). */
  NOTIFY_WORKER_ENABLED: z.stringbool().default(false),
  /** `smtp` sends through SMTP_URL; `none` skips every email (rows are marked skipped). */
  NOTIFY_EMAIL_PROVIDER: z.enum(["none", "smtp"]).default("none"),
  /** `smtp://user:pass@host:587` or `smtps://...`. Never logged. */
  SMTP_URL: z.string().optional(),
  NOTIFY_EMAIL_FROM: z.string().min(3).default("Sisters of Beauty <no-reply@localhost>"),
  /** `twilio` uses the Twilio REST adapter; `none` (default) skips every SMS. */
  NOTIFY_SMS_PROVIDER: z.enum(["none", "twilio"]).default("none"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Sender number or messaging service id, E.164 or `MG...`. */
  TWILIO_FROM: z.string().optional(),
  NOTIFY_POLL_INTERVAL_MS: positiveInt.default(5000),
  NOTIFY_BATCH_SIZE: positiveInt.default(10),
  /** How long a claimed job stays invisible to other workers before it is retried. */
  NOTIFY_VISIBILITY_TIMEOUT_SECONDS: positiveInt.default(120),
  NOTIFY_MAX_ATTEMPTS: positiveInt.default(5),
  NOTIFY_BACKOFF_BASE_SECONDS: positiveInt.default(30),
  NOTIFY_BACKOFF_MAX_SECONDS: positiveInt.default(3600),
  /** Scheduled housekeeping (see docs/operations.md). Runs in the worker, and in the API when it hosts the worker. */
  MAINTENANCE_ENABLED: z.stringbool().default(true),
  MAINTENANCE_INTERVAL_HOURS: positiveInt.default(24),
  SYNC_LOG_RETENTION_DAYS: positiveInt.default(30),
  REMINDER_RETENTION_DAYS: positiveInt.default(90),
  DEAD_LETTER_RETENTION_DAYS: positiveInt.default(180),
  OAUTH_TOKEN_GRACE_DAYS: positiveInt.default(7),
  OAUTH_IDLE_CLIENT_DAYS: positiveInt.default(30),
  /** Language of messages for clients without a stored preference: `en` or `es-AR`. */
  NOTIFY_DEFAULT_LOCALE: z.enum(["en", "es-AR"]).default("en"),
  /** Public origin of the web app used in links; defaults to BETTER_AUTH_URL. */
  NOTIFY_PUBLIC_URL: z.union([z.url(), z.literal("").transform(() => undefined)]).optional(),
});

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

export interface NotificationConfig {
  workerEnabled: boolean;
  email: { provider: "none" | "smtp"; smtpUrl?: string; from: string };
  sms: { provider: "none" | "twilio"; accountSid?: string; authToken?: string; from?: string };
  pollIntervalMs: number;
  batchSize: number;
  visibilityTimeoutSeconds: number;
  maxAttempts: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  defaultLocale: "en" | "es-AR";
  /** Origin of the web app, no trailing slash. */
  publicUrl: string;
  /** HMAC key for opt-out links, derived from the auth secret. */
  signingSecret: string;
}

export interface MaintenanceConfig {
  enabled: boolean;
  intervalHours: number;
  retention: {
    syncLogDays: number;
    reminderDays: number;
    deadLetterDays: number;
    oauthGraceDays: number;
    idleClientDays: number;
  };
}

export interface AppConfig {
  databaseUrl: string;
  valkeyUrl: string;
  valkeyKeyPrefix: string;
  port: number;
  http: { idleTimeoutSeconds: number; maxRequestBodyBytes: number };
  auth: {
    secret: string;
    baseURL: string;
    trustedOrigins: string[];
    /** Cookies carry the Secure attribute over https and in production. */
    secureCookies: boolean;
    requireEmailVerification: boolean;
  };
  oauth: {
    /** Resource identifier and audience of every access token this API accepts at `/mcp`. */
    mcpResource: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  notifications: NotificationConfig;
  maintenance: MaintenanceConfig;
  trustProxy: boolean;
  metricsToken?: string;
  shutdownGraceMs: number;
  rateLimit: {
    global: RateLimitRule;
    auth: RateLimitRule;
    syncStream: RateLimitRule;
    oauth: RateLimitRule;
    oauthRegister: RateLimitRule;
    mcp: RateLimitRule;
  };
}

/** Variables that may be supplied as `<NAME>_FILE=/run/secrets/...` (Docker and Kubernetes secrets). */
const FILE_BACKED = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "SMTP_URL",
  "TWILIO_AUTH_TOKEN",
  "METRICS_TOKEN",
] as const;

/** A plain variable wins; otherwise the file's content (minus the trailing newline) is used. */
function withSecretFiles(env: Record<string, string | undefined>) {
  const resolved = { ...env };
  for (const name of FILE_BACKED) {
    const path = env[`${name}_FILE`];
    if (env[name] || !path) continue;
    try {
      resolved[name] = readFileSync(path, "utf8").replace(/\r?\n+$/, "");
    } catch {
      throw new Error(`Invalid environment configuration:\n  - ${name}_FILE: cannot read ${path}`);
    }
  }
  return resolved;
}

/** Parses and validates the environment once, failing fast with every problem listed. */
export function loadConfig(input: Record<string, string | undefined> = process.env): AppConfig {
  const env = withSecretFiles(input);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  if (e.NOTIFY_EMAIL_PROVIDER === "smtp" && !e.SMTP_URL) {
    throw new Error(
      "Invalid environment configuration:\n  - SMTP_URL: required when NOTIFY_EMAIL_PROVIDER=smtp",
    );
  }
  if (
    e.NODE_ENV === "production" &&
    e.AUTH_REQUIRE_EMAIL_VERIFICATION &&
    e.NOTIFY_EMAIL_PROVIDER === "none"
  ) {
    throw new Error(
      "Invalid environment configuration:\n  - AUTH_REQUIRE_EMAIL_VERIFICATION: clients could never confirm their address. " +
        "Set NOTIFY_EMAIL_PROVIDER=smtp (and SMTP_URL), or AUTH_REQUIRE_EMAIL_VERIFICATION=false to opt out explicitly",
    );
  }
  if (
    e.NOTIFY_SMS_PROVIDER === "twilio" &&
    !(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM)
  ) {
    throw new Error(
      "Invalid environment configuration:\n  - TWILIO_*: ACCOUNT_SID, AUTH_TOKEN and FROM are required when NOTIFY_SMS_PROVIDER=twilio",
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    valkeyUrl: e.VALKEY_URL,
    valkeyKeyPrefix: e.VALKEY_KEY_PREFIX,
    port: e.PORT,
    http: {
      idleTimeoutSeconds: e.HTTP_IDLE_TIMEOUT_SECONDS,
      maxRequestBodyBytes: e.HTTP_MAX_BODY_BYTES,
    },
    auth: {
      secret: e.BETTER_AUTH_SECRET,
      baseURL: e.BETTER_AUTH_URL,
      trustedOrigins: e.TRUSTED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      secureCookies: e.NODE_ENV === "production" || e.BETTER_AUTH_URL.startsWith("https://"),
      requireEmailVerification: e.AUTH_REQUIRE_EMAIL_VERIFICATION,
    },
    oauth: {
      mcpResource: e.MCP_RESOURCE_URL ?? `${e.BETTER_AUTH_URL.replace(/\/+$/, "")}/mcp`,
      accessTokenTtlSeconds: e.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: e.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    },
    notifications: {
      workerEnabled: e.NOTIFY_WORKER_ENABLED,
      email: { provider: e.NOTIFY_EMAIL_PROVIDER, smtpUrl: e.SMTP_URL, from: e.NOTIFY_EMAIL_FROM },
      sms: {
        provider: e.NOTIFY_SMS_PROVIDER,
        accountSid: e.TWILIO_ACCOUNT_SID,
        authToken: e.TWILIO_AUTH_TOKEN,
        from: e.TWILIO_FROM,
      },
      pollIntervalMs: e.NOTIFY_POLL_INTERVAL_MS,
      batchSize: e.NOTIFY_BATCH_SIZE,
      visibilityTimeoutSeconds: e.NOTIFY_VISIBILITY_TIMEOUT_SECONDS,
      maxAttempts: e.NOTIFY_MAX_ATTEMPTS,
      backoffBaseSeconds: e.NOTIFY_BACKOFF_BASE_SECONDS,
      backoffMaxSeconds: e.NOTIFY_BACKOFF_MAX_SECONDS,
      defaultLocale: e.NOTIFY_DEFAULT_LOCALE,
      publicUrl: (e.NOTIFY_PUBLIC_URL ?? e.BETTER_AUTH_URL).replace(/\/+$/, ""),
      signingSecret: `sob.notifications.v1:${e.BETTER_AUTH_SECRET}`,
    },
    maintenance: {
      enabled: e.MAINTENANCE_ENABLED,
      intervalHours: e.MAINTENANCE_INTERVAL_HOURS,
      retention: {
        syncLogDays: e.SYNC_LOG_RETENTION_DAYS,
        reminderDays: e.REMINDER_RETENTION_DAYS,
        deadLetterDays: e.DEAD_LETTER_RETENTION_DAYS,
        oauthGraceDays: e.OAUTH_TOKEN_GRACE_DAYS,
        idleClientDays: e.OAUTH_IDLE_CLIENT_DAYS,
      },
    },
    trustProxy: e.TRUST_PROXY,
    metricsToken: e.METRICS_TOKEN,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
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
