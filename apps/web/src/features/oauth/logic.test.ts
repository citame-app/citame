import { describe, expect, test } from "bun:test";
import { consentScopes, isOAuthSearch, parseOAuthRequest, redirectHost } from "./logic";

const SEARCH =
  "?response_type=code&client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&scope=mcp%3Aread+mcp%3Abook+schedule%3Aread+offline_access&state=s&resource=https%3A%2F%2Fsalon.example%2Fmcp&exp=1&sig=SIG";

describe("parseOAuthRequest", () => {
  test("extracts the client, scopes, redirect target and the raw signed query", () => {
    const request = parseOAuthRequest(SEARCH);
    expect(request?.clientId).toBe("abc123");
    expect(request?.scopes).toEqual(["mcp:read", "mcp:book", "schedule:read", "offline_access"]);
    expect(request?.redirectUri).toBe("http://127.0.0.1:8976/callback");
    expect(request?.query).toBe(SEARCH.slice(1));
  });

  test("works with or without the leading question mark", () => {
    expect(parseOAuthRequest(SEARCH.slice(1))?.clientId).toBe("abc123");
  });

  test("drops scopes this app does not know instead of showing them", () => {
    const request = parseOAuthRequest("client_id=c&scope=mcp%3Aread+evil%3Aall&sig=x");
    expect(request?.scopes).toEqual(["mcp:read"]);
  });

  test("is null without a client id or without the server's signature", () => {
    expect(parseOAuthRequest("redirect=%2Faccount")).toBeNull();
    expect(parseOAuthRequest("client_id=c&scope=mcp%3Aread")).toBeNull();
    expect(parseOAuthRequest("")).toBeNull();
  });

  test("isOAuthSearch tells an authorization request from a plain sign-in link", () => {
    expect(isOAuthSearch(SEARCH)).toBe(true);
    expect(isOAuthSearch("?redirect=%2Faccount")).toBe(false);
  });
});

describe("redirectHost", () => {
  test("shows the host the user will be sent back to", () => {
    expect(redirectHost("http://127.0.0.1:8976/callback")).toBe("127.0.0.1:8976");
    expect(redirectHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
  });

  test("custom schemes and garbage degrade to something displayable", () => {
    expect(redirectHost("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe("cursor://");
    expect(redirectHost("not a url")).toBeNull();
    expect(redirectHost(undefined)).toBeNull();
  });
});

describe("consentScopes", () => {
  test("a client account is never offered the staff schedule scope", () => {
    const request = parseOAuthRequest(SEARCH);
    const scopes = consentScopes(request?.scopes ?? [], "client");
    expect(scopes.map((s) => s.scope)).toEqual(["mcp:read", "mcp:book", "offline_access"]);
  });

  test("staff and owners can grant the schedule scope", () => {
    const request = parseOAuthRequest(SEARCH);
    for (const role of ["staff", "owner"] as const) {
      expect(consentScopes(request?.scopes ?? [], role).map((s) => s.scope)).toContain(
        "schedule:read",
      );
    }
  });

  test("reading is always granted; the others can be switched off", () => {
    const request = parseOAuthRequest(SEARCH);
    const byScope = Object.fromEntries(
      consentScopes(request?.scopes ?? [], "owner").map((s) => [s.scope, s.required]),
    );
    expect(byScope).toEqual({
      "mcp:read": true,
      "mcp:book": false,
      "schedule:read": false,
      offline_access: false,
    });
  });
});
