import { z } from "zod";

/**
 * OAuth scopes of the authorization server (ADR 0009). A scope caps what a token may do; the
 * user's role caps what any token of that user may do. The effective permission is the
 * intersection, evaluated on every MCP call.
 */
export const MCP_MANAGEMENT_SCOPES = [
  "operations:read",
  "schedule:write",
  "clients:write",
  "catalog:write",
  "stock:write",
  "sales:write",
  "billing:write",
  "cash:write",
  "commissions:write",
  "settings:write",
] as const;
export const DESKTOP_SIGN_IN_SCOPE = "desktop:sign-in";
export const MCP_SCOPES = [
  "mcp:read",
  "mcp:book",
  "schedule:read",
  ...MCP_MANAGEMENT_SCOPES,
  "offline_access",
] as const;
export const OAUTH_SCOPES = [...MCP_SCOPES, DESKTOP_SIGN_IN_SCOPE] as const;
export const isManagementScope = (scope: OAuthScope) =>
  MCP_MANAGEMENT_SCOPES.some((management) => scope === management);
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

export const desktopWorkspaceSchema = z.enum([
  "waitlist",
  "clients",
  "services",
  "staff",
  "resources",
  "sales",
  "transactions",
  "inventory",
  "benefits",
  "reports",
  "commissions",
  "marketing",
  "reputation",
  "settings",
  "whatsapp",
]);
export type DesktopWorkspace = z.infer<typeof desktopWorkspaceSchema>;
export const desktopWorkspacesResponseSchema = z.object({
  workspaces: z.array(desktopWorkspaceSchema),
});
export type DesktopWorkspacesResponse = z.infer<typeof desktopWorkspacesResponseSchema>;

/** Routes supported by the desktop client and exposed through the same-origin proxy. */
export const DESKTOP_PROXY_ROUTE =
  /^\/(?:me(?:\/desktop-workspaces)?|sync\/(?:pull|push|stream)|intake\/requirements|appointments\/[\da-f-]+\/context|admin\/staff\/[\da-f-]+\/(?:date-shifts(?:\/preview)?|working-hours)|admin\/reports\/(?:summary|clients|outcomes(?:\/export)?)|admin\/reviews(?:\/requests(?:\/[\da-f-]+\/email)?|\/[\da-f-]+\/(?:moderation|reply))?|admin\/passes\/eligible|admin\/notifications\/inbox(?:\/archive)?|admin\/waitlist\/desk(?:\/policy|\/[\da-f-]+\/(?:cancel|accept|decline))?|admin\/inventory\/(?:returns|movements(?:\/export)?|products(?:\/[\da-f-]+(?:\/(?:package-content|movements))?)?)|admin\/commerce\/(?:unpaid|capabilities|payments\/[\da-f-]+\/refunds|appointments\/[\da-f-]+\/imported-(?:price|settlement|partial-payment)|checkouts(?:\/[\da-f-]+(?:\/(?:payments|prices|void))?)?|cash-sessions(?:\/(?:current|adjust|[\da-f-]+\/close))?))(?:\?|$)/;

export const oauthConnectionIdSchema = z.string().min(1).max(512);
export const oauthConnectionsSchema = z.object({
  connections: z.array(
    z.object({
      clientId: oauthConnectionIdSchema,
      name: z.string().nullable(),
      scopes: z.array(oauthScopeSchema),
      updatedAt: z.iso.datetime(),
    }),
  ),
});

export const desktopDevicesSchema = z.object({
  devices: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      linkedAt: z.iso.datetime(),
      lastSeenAt: z.iso.datetime(),
    }),
  ),
});

export const desktopDeviceLinkResponseSchema = z.object({ deviceId: z.uuid() });
export const oauthConsentResponseSchema = z.object({ url: z.url() });
export const oauthAccessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
});
