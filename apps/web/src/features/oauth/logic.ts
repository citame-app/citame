import { type OAuthScope, parseScopes, type UserRole } from "@sob/contracts";

/** An authorization request as the consent and sign-in pages see it. */
export interface OAuthRequest {
  clientId: string;
  scopes: OAuthScope[];
  redirectUri: string | undefined;
  /**
   * The raw query exactly as the authorization server sent it, signature included. It is sent
   * back untouched: the server verifies it, so nothing in it can be altered by this page.
   */
  query: string;
}

function params(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

/**
 * Reads an authorization request from a page's query string. A request only counts when it
 * carries the server's signature (`sig`): a hand-made link to /consent is not a request.
 */
export function parseOAuthRequest(search: string): OAuthRequest | null {
  const p = params(search);
  const clientId = p.get("client_id");
  if (!clientId || !p.get("sig")) return null;
  return {
    clientId,
    scopes: parseScopes(p.get("scope")),
    redirectUri: p.get("redirect_uri") ?? undefined,
    query: search.startsWith("?") ? search.slice(1) : search,
  };
}

export function isOAuthSearch(search: string): boolean {
  return parseOAuthRequest(search) !== null;
}

/**
 * Where the user will land after deciding, as a short string to show next to the app name so a
 * look-alike client is easier to spot. Custom schemes (desktop apps) show the scheme only.
 */
export function redirectHost(redirectUri: string | undefined): string | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host;
    return `${url.protocol}//`;
  } catch {
    return null;
  }
}

export interface ConsentScope {
  scope: OAuthScope;
  /** Cannot be switched off: the app is useless without it. */
  required: boolean;
}

const FRONT_DESK: readonly UserRole[] = ["owner", "staff"];

/**
 * The scopes worth asking this account about. `schedule:read` is hidden from client accounts
 * (the tools behind it are role-gated and would never work), so the screen never offers a
 * permission that does nothing. The server still enforces role and scope on every call.
 */
export function consentScopes(requested: readonly OAuthScope[], role: UserRole): ConsentScope[] {
  return requested
    .filter((scope) => scope !== "schedule:read" || FRONT_DESK.includes(role))
    .map((scope) => ({ scope, required: scope === "mcp:read" }));
}
