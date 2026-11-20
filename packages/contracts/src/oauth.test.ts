import { describe, expect, test } from "bun:test";
import { OAUTH_SCOPES, oauthScopeSchema, parseScopes } from "./index";

describe("OAuth scopes", () => {
  test("the scope catalogue is closed and stable", () => {
    expect(OAUTH_SCOPES).toContain("operations:read");
    expect(OAUTH_SCOPES).toContain("schedule:write");
    expect(oauthScopeSchema.safeParse("mcp:read").success).toBe(true);
    expect(oauthScopeSchema.safeParse("admin").success).toBe(false);
  });

  test("parseScopes splits a space-separated list and drops unknown or repeated values", () => {
    expect(parseScopes("mcp:read  mcp:book mcp:read bogus")).toEqual(["mcp:read", "mcp:book"]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });
});
