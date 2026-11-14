import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const SECRET = "x".repeat(32);

describe("loadConfig", () => {
  test("applies defaults and requires only the auth secret", () => {
    const config = loadConfig({ BETTER_AUTH_SECRET: SECRET });
    expect(config.port).toBe(3000);
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
    const base = { BETTER_AUTH_SECRET: SECRET };
    expect(
      loadConfig({ ...base, BETTER_AUTH_URL: "https://salon.example" }).auth.secureCookies,
    ).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: "production" }).auth.secureCookies).toBe(true);
    expect(loadConfig(base).auth.secureCookies).toBe(false);
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
});
