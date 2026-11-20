import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const SECRET = "x".repeat(32);

describe("loadConfig", () => {
  test("applies defaults and requires only the auth secret", () => {
    const config = loadConfig({ BETTER_AUTH_SECRET: SECRET });
    expect(config.port).toBe(3000);
    expect(config.http).toEqual({ idleTimeoutSeconds: 30, maxRequestBodyBytes: 1_048_576 });
    expect(config.valkeyKeyPrefix).toBe("sob:");
    expect(config.trustProxy).toBe(false);
    expect(config.auth.trustedOrigins).toEqual([]);
    expect(config.auth.secureCookies).toBe(false);
    expect(config.rateLimit.auth).toEqual({ max: 10, windowSeconds: 60 });
    expect(config.rateLimit.global).toEqual({ max: 300, windowSeconds: 60 });
  });

  test("fails fast, listing the problem, when the secret is missing or short", () => {
    expect(() => loadConfig({})).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
  });

  test("parses trusted origins, proxy trust and rate limits from env", () => {
    const config = loadConfig({
      BETTER_AUTH_SECRET: SECRET,
      TRUSTED_ORIGINS: "https://a.example, https://b.example ,",
      TRUST_PROXY: "true",
      RATE_LIMIT_AUTH_MAX: "3",
      RATE_LIMIT_AUTH_WINDOW_SECONDS: "30",
      VALKEY_KEY_PREFIX: "test:1:",
    });
    expect(config.auth.trustedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(config.trustProxy).toBe(true);
    expect(config.rateLimit.auth).toEqual({ max: 3, windowSeconds: 30 });
    expect(config.valkeyKeyPrefix).toBe("test:1:");
  });

  test("cookies are Secure over https and in production, never silently insecure", () => {
    const base = { BETTER_AUTH_SECRET: SECRET, AUTH_REQUIRE_EMAIL_VERIFICATION: "false" };
    expect(
      loadConfig({ ...base, BETTER_AUTH_URL: "https://salon.example" }).auth.secureCookies,
    ).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: "production" }).auth.secureCookies).toBe(true);
    expect(loadConfig(base).auth.secureCookies).toBe(false);
  });

  test("email verification is on by default and cannot be silently unreachable in production", () => {
    expect(loadConfig({ BETTER_AUTH_SECRET: SECRET }).auth.requireEmailVerification).toBe(true);
    expect(
      loadConfig({ BETTER_AUTH_SECRET: SECRET, AUTH_REQUIRE_EMAIL_VERIFICATION: "false" }).auth
        .requireEmailVerification,
    ).toBe(false);
    // Production with verification required but no way to send mail would lock every client out.
    expect(() => loadConfig({ BETTER_AUTH_SECRET: SECRET, NODE_ENV: "production" })).toThrow(
      /AUTH_REQUIRE_EMAIL_VERIFICATION/,
    );
    expect(
      loadConfig({
        BETTER_AUTH_SECRET: SECRET,
        NODE_ENV: "production",
        NOTIFY_EMAIL_PROVIDER: "smtp",
        SMTP_URL: "smtp://mail:25",
      }).auth.requireEmailVerification,
    ).toBe(true);
  });

  test("maintenance defaults to daily with the documented retention windows", () => {
    const base = { BETTER_AUTH_SECRET: SECRET };
    expect(loadConfig(base).maintenance).toEqual({
      enabled: true,
      intervalHours: 24,
      retention: {
        syncLogDays: 30,
        reminderDays: 90,
        deadLetterDays: 180,
        oauthGraceDays: 7,
        idleClientDays: 30,
      },
    });
    const custom = loadConfig({
      ...base,
      MAINTENANCE_ENABLED: "false",
      MAINTENANCE_INTERVAL_HOURS: "6",
      SYNC_LOG_RETENTION_DAYS: "14",
    }).maintenance;
    expect(custom.enabled).toBe(false);
    expect(custom.intervalHours).toBe(6);
    expect(custom.retention.syncLogDays).toBe(14);
    expect(() => loadConfig({ ...base, REMINDER_RETENTION_DAYS: "0" })).toThrow(
      /REMINDER_RETENTION_DAYS/,
    );
  });

  test("secrets may come from files (Docker/Kubernetes secrets) through KEY_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "sob-secrets-"));
    try {
      writeFileSync(join(dir, "auth"), `${"s".repeat(40)}\n`);
      writeFileSync(join(dir, "db"), "postgres://sob:pw@db:5432/sob\n");
      writeFileSync(join(dir, "meta-app"), `${"a".repeat(32)}\n`);
      writeFileSync(join(dir, "meta-verify"), `${"v".repeat(32)}\n`);
      const config = loadConfig({
        BETTER_AUTH_SECRET_FILE: join(dir, "auth"),
        DATABASE_URL_FILE: join(dir, "db"),
        META_WHATSAPP_APP_ID: "12345",
        META_WHATSAPP_CONFIG_ID: "67890",
        META_WHATSAPP_APP_SECRET: "",
        META_WHATSAPP_APP_SECRET_FILE: join(dir, "meta-app"),
        META_WHATSAPP_VERIFY_TOKEN_FILE: join(dir, "meta-verify"),
      });
      // Trailing newlines (every editor adds one) are not part of the secret.
      expect(config.auth.secret).toBe("s".repeat(40));
      expect(config.databaseUrl).toBe("postgres://sob:pw@db:5432/sob");
      expect(config.notifications.whatsapp).toMatchObject({
        appSecret: "a".repeat(32),
        verifyToken: "v".repeat(32),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plain variable wins over its _FILE twin, and a missing file is a loud error", () => {
    expect(
      loadConfig({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_SECRET_FILE: "/nope" }).auth.secret,
    ).toBe(SECRET);
    expect(() => loadConfig({ BETTER_AUTH_SECRET_FILE: "/definitely/not/here" })).toThrow(
      /BETTER_AUTH_SECRET_FILE/,
    );
  });

  test("metrics token and shutdown grace are optional and validated", () => {
    const base = { BETTER_AUTH_SECRET: SECRET };
    expect(loadConfig(base).metricsToken).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_TOKEN: "" }).metricsToken).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_TOKEN: "0123456789abcdef" }).metricsToken).toBe(
      "0123456789abcdef",
    );
    expect(() => loadConfig({ ...base, METRICS_TOKEN: "short" })).toThrow(/METRICS_TOKEN/);
    expect(loadConfig({ ...base, SHUTDOWN_GRACE_MS: "5000" }).shutdownGraceMs).toBe(5000);
  });

  test("rejects non-positive rate limits", () => {
    expect(() => loadConfig({ BETTER_AUTH_SECRET: SECRET, RATE_LIMIT_AUTH_MAX: "0" })).toThrow(
      /RATE_LIMIT_AUTH_MAX/,
    );
  });

  test("an empty MCP_RESOURCE_URL (Compose passes unset variables as empty) means the default", () => {
    const config = loadConfig({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://salon.example",
      MCP_RESOURCE_URL: "",
    });
    expect(config.oauth.mcpResource).toBe("https://salon.example/mcp");
  });

  test("derives the MCP resource from the public URL and exposes OAuth defaults", () => {
    const config = loadConfig({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://salon.example/",
    });
    expect(config.oauth.mcpResource).toBe("https://salon.example/mcp");
    expect(config.oauth.accessTokenTtlSeconds).toBe(900);
    expect(config.oauth.refreshTokenTtlSeconds).toBe(14 * 24 * 60 * 60);
    expect(config.rateLimit.oauthRegister).toEqual({ max: 10, windowSeconds: 60 });
    expect(
      loadConfig({ BETTER_AUTH_SECRET: SECRET, MCP_RESOURCE_URL: "https://mcp.example/mcp" }).oauth
        .mcpResource,
    ).toBe("https://mcp.example/mcp");
  });

  test("public OAuth URLs require HTTPS in production and cannot carry secrets or fragments", () => {
    const production = {
      BETTER_AUTH_SECRET: SECRET,
      NODE_ENV: "production",
      AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    };
    expect(() => loadConfig({ ...production, BETTER_AUTH_URL: "http://salon.example" })).toThrow(
      "BETTER_AUTH_URL",
    );
    for (const url of [
      "http://mcp.example/mcp",
      "https://mcp.example/mcp#fragment",
      "https://mcp.example/mcp?key=opaque",
      "https://user@mcp.example/mcp",
    ]) {
      expect(() => loadConfig({ ...production, MCP_RESOURCE_URL: url })).toThrow(
        "MCP_RESOURCE_URL",
      );
    }
    expect(loadConfig(production).oauth.mcpResource).toBe("http://localhost:3000/mcp");
  });
});

test("payment gateways are disabled by default and enabled Redsys requires complete private configuration", () => {
  expect(loadConfig({ BETTER_AUTH_SECRET: SECRET }).payments.provider).toBe("none");
  expect(() => loadConfig({ BETTER_AUTH_SECRET: SECRET, PAYMENT_PROVIDER: "redsys" })).toThrow(
    "REDSYS",
  );
  const ready = loadConfig({
    BETTER_AUTH_SECRET: SECRET,
    PAYMENT_PROVIDER: "redsys",
    REDSYS_MERCHANT_CODE: "999008881",
    REDSYS_TERMINAL: "1",
    REDSYS_SECRET_KEY: "public-test-key",
    REDSYS_ENVIRONMENT: "test",
  });
  expect(ready.payments.redsys?.environment).toBe("test");
  expect(ready.payments.bizumEnabled).toBe(false);
  expect(() =>
    loadConfig({
      BETTER_AUTH_SECRET: SECRET,
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "1",
      REDSYS_SECRET_KEY: "public-test-key",
      REDSYS_ENVIRONMENT: "live",
    }),
  ).toThrow("HTTPS");
});
test("recurring payment configuration is opt-in and requires a separate valid encryption key", () => {
  const base = {
    BETTER_AUTH_SECRET: SECRET,
    PAYMENT_PROVIDER: "redsys",
    REDSYS_MERCHANT_CODE: "999008881",
    REDSYS_TERMINAL: "001",
    REDSYS_SECRET_KEY: "public-test-key",
    REDSYS_ENVIRONMENT: "test",
  };
  expect(loadConfig(base).payments.recurringEnabled).toBe(false);
  expect(() => loadConfig({ ...base, REDSYS_RECURRING_ENABLED: "true" })).toThrow(
    "PAYMENT_TOKEN_ENCRYPTION_KEY",
  );
  expect(() =>
    loadConfig({
      ...base,
      REDSYS_RECURRING_ENABLED: "true",
      PAYMENT_TOKEN_ENCRYPTION_KEY: "private-invalid-key",
    }),
  ).toThrow("Payment encryption key unavailable");
  const ready = loadConfig({
    ...base,
    REDSYS_RECURRING_ENABLED: "true",
    PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  expect(ready.payments.recurringEnabled).toBe(true);
  expect(ready.payments.redsys?.recurringEnabled).toBe(true);
  expect(() =>
    loadConfig({ BETTER_AUTH_SECRET: SECRET, REDSYS_RECURRING_ENABLED: "true" }),
  ).toThrow("requires Redsys");
});
