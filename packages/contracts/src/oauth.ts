import { z } from "zod";

/**
 * OAuth scopes of the authorization server (ADR 0009). A scope caps what a token may do; the
 * user's role caps what any token of that user may do. The effective permission is the
 * intersection, evaluated on every MCP call.
 */
export const OAUTH_SCOPES = ["mcp:read", "mcp:book", "schedule:read", "offline_access"] as const;
export const oauthScopeSchema = z.enum(OAUTH_SCOPES);
export type OAuthScope = z.infer<typeof oauthScopeSchema>;

/** Splits a space-separated scope string, keeping known scopes once, in order. */
export function parseScopes(value: string | null | undefined): OAuthScope[] {
  const seen = new Set<OAuthScope>();
  for (const part of (value ?? "").split(/\s+/)) {
    const parsed = oauthScopeSchema.safeParse(part);
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

/** First-party public client of the desktop app, pre-registered at startup. */
export const DESKTOP_CLIENT_ID = "sob-desktop";
