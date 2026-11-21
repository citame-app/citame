import { z } from "zod";
import { idSchema } from "./common";

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
  "intake_forms",
  "whatsapp",
]);
export type DesktopWorkspace = z.infer<typeof desktopWorkspaceSchema>;
export const desktopWorkspacesResponseSchema = z.object({
  workspaces: z.array(desktopWorkspaceSchema),
});
export type DesktopWorkspacesResponse = z.infer<typeof desktopWorkspacesResponseSchema>;
export const desktopReceiptDestinationSchema = z.strictObject({ receipt: idSchema });

/** Routes supported by the desktop client and exposed through the same-origin proxy. */
export const DESKTOP_PROXY_ROUTE =
  /^\/(?:me(?:\/desktop-workspaces)?|sync\/(?:pull|push|stream)|intake\/requirements|admin\/whatsapp\/desk|admin\/email-delivery(?:\/test-reviewed)?|admin\/settings\/(?:booking-policy\/reviewed|desktop)|admin\/intake-forms(?:\/[\da-f-]+(?:\/(?:publish|archive))?)?|admin\/clients\/[\da-f-]+\/(?:controls|intake(?:\/(?:catalog|[\da-f-]+))?)|appointments\/(?:desktop-booking|[\da-f-]+\/context)|admin\/portfolio(?:\/[\da-f-]+(?:\/(?:image|publish|unpublish|remove))?)?|admin\/services\/(?:reviewed|[\da-f-]+\/(?:resources\/)?reviewed)|admin\/staff-accounts|admin\/staff\/[\da-f-]+\/(?:date-shifts(?:\/preview)?|working-hours|access\/reviewed)|admin\/reports\/(?:summary|clients|outcomes(?:\/export)?)|admin\/reviews(?:\/requests(?:\/[\da-f-]+\/email)?|\/[\da-f-]+\/(?:moderation|reply))?|admin\/passes\/(?:eligible|refund-quote)|admin\/notifications\/inbox(?:\/archive)?|admin\/waitlist\/desk(?:\/policy|\/[\da-f-]+\/(?:cancel|accept|decline))?|admin\/inventory\/(?:facets|returns|warehouse-stock|(?:transfers|stock-adjustments)\/[\da-f-]+|(?:orders|suppliers|receipts|warehouses|classifications)(?:\/[\da-f-]+)?|movements(?:\/export)?|products(?:\/(?:report|export|[\da-f-]+(?:\/(?:package-content|movements|photo\/[\da-f-]+))?))?)|admin\/commerce\/(?:unpaid|capabilities|payments\/[\da-f-]+\/(?:refunds|reconcile)|refunds\/[\da-f-]+\/(?:cancel|execute|reconcile)|appointments\/[\da-f-]+\/imported-(?:price|settlement|partial-payment)|checkouts(?:\/[\da-f-]+(?:\/(?:payments|prices|void))?)?|cash-sessions(?:\/(?:current|adjust|[\da-f-]+\/close))?))(?:\?|$)/;

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
