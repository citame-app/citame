import {
  DESKTOP_CLIENT_ID,
  DESKTOP_PROXY_ROUTE,
  DESKTOP_SIGN_IN_SCOPE,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { clientProfile, type Database, staffProfile, user } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { clientIdentityIds } from "../client-identity";
import { DomainError } from "../errors";
import { BearerError, type TokenVerifier } from "../mcp/verify";
import type { Tx } from "../tx";
import type { Auth } from "./auth";

/** The authenticated caller as the authorization layer sees it. */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  /** Calendar profile, when the account is (or was made) staff. */
  staffId: string | null;
  accessPreset?: StaffAccessPreset;
  /** Booking profile, when the account is a client. */
  clientId: string | null;
  clientIds?: string[];
}
export const ownsClient = (principal: Pick<Principal, "clientId" | "clientIds">, id: string) =>
  principal.clientId === id || Boolean(principal.clientIds?.includes(id));
export const ownedClientIds = (principal: Pick<Principal, "clientId" | "clientIds">) =>
  principal.clientIds ?? (principal.clientId ? [principal.clientId] : []);

export type AppEnv = { Variables: { principal: Principal; desktopRequest?: boolean } };

/**
 * Resolves a principal from the database. The role is read here on every request instead of
 * trusting the cached session payload, so a role change takes effect immediately even though
 * sessions live in Valkey for days.
 */
export async function loadPrincipal(db: Database | Tx, userId: string): Promise<Principal | null> {
  const [row] = await db.select().from(user).where(eq(user.id, userId));
  if (!row) return null;

  const [staff] = await db
    .select({ id: staffProfile.id, accessPreset: staffProfile.accessPreset })
    .from(staffProfile)
    .where(and(eq(staffProfile.userId, userId), isNull(staffProfile.deletedAt)));
  let [client] = await db
    .select({ id: clientProfile.id })
    .from(clientProfile)
    .where(and(eq(clientProfile.userId, userId), isNull(clientProfile.deletedAt)));

  // Self-heal: the profile is created right after sign-up in a separate statement, so a crash
  // in between must not leave a client who can never book.
  if (row.role === "client" && !client) {
    // A profile soft-deleted by the owner still owns the unique `user_id`: restore it (history
    // included) instead of colliding with it, otherwise the login could never book again.
    const restored = await db
      .update(clientProfile)
      .set({ deletedAt: null })
      .where(eq(clientProfile.userId, userId))
      .returning({ id: clientProfile.id });
    if (restored.length === 0) {
      await db
        .insert(clientProfile)
        .values({ name: row.name, email: row.email, userId })
        .onConflictDoNothing();
    }
    [client] = await db
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(eq(clientProfile.userId, userId), isNull(clientProfile.deletedAt)));
  }

  const identities = client ? await clientIdentityIds(db, client.id) : [];
  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    staffId: staff?.id ?? null,
    accessPreset: staff?.accessPreset,
    clientId: client?.id ?? null,
    ...(identities.length > 1 ? { clientIds: identities } : {}),
  };
}

/** Requires a valid session cookie and exposes the principal as `c.get("principal")`. */
export function requireAuth(
  auth: Auth,
  db: Database,
  desktop?: TokenVerifier,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    if (desktop && authorization) {
      const { path, method } = c.req;
      const inventoryAllowed =
        path === "/admin/inventory/returns"
          ? method === "POST"
          : path.endsWith("/package-content")
            ? method === "PATCH"
            : method === "GET" ||
              (method === "POST" &&
                path.startsWith("/admin/inventory/products/") &&
                path.endsWith("/movements"));
      const dateShiftAllowed = path.endsWith("/preview")
        ? method === "POST"
        : method === "GET" || method === "POST";
      const intakeAllowed =
        path === "/admin/intake-forms"
          ? method === "GET" || method === "POST"
          : path.endsWith("/publish") || path.endsWith("/archive")
            ? method === "POST"
            : method === "GET" || method === "PUT";
      const portfolioAllowed =
        path === "/admin/portfolio"
          ? method === "GET" || method === "POST"
          : path.endsWith("/image")
            ? method === "GET"
            : /\/(?:publish|unpublish|remove)$/.test(path)
              ? method === "POST"
              : method === "PUT";
      const clientDetailAllowed =
        method === "GET" ||
        (path.endsWith("/intake") && method === "POST") ||
        (path.endsWith("/controls") && method === "PATCH");
      const accountingAllowed = path.endsWith("/policy/reviewed")
        ? method === "GET" || method === "PUT"
        : path.endsWith("/payouts/reviewed")
          ? method === "POST"
          : method === "GET" ||
            (method === "PUT" &&
              /^\/admin\/accounting\/appointment-profitability\/[\da-f-]+\/costs$/.test(path));
      const campaignMutation =
        (method === "POST" &&
          /^\/admin\/marketing\/campaigns(?:\/[\da-f-]+\/(?:queue|cancel|test-email))?$/.test(
            path,
          )) ||
        (method === "PATCH" && /^\/admin\/marketing\/campaigns\/[\da-f-]+$/.test(path));
      const giftCardMethod = /\/(?:code|check|reissue)$/.test(path)
        ? method === "POST"
        : path.endsWith("/expiry")
          ? method === "PATCH"
          : method === "GET" || (path === "/admin/gift-cards" && method === "POST");
      const rewardsAllowed =
        path === "/admin/rewards/stamps/program" || path === "/admin/rewards/policy/reviewed"
          ? method === "GET" || method === "PUT"
          : /^\/admin\/rewards\/stamps\/cards(?:\/[\da-f-]+)?$/.test(path) ||
              path === "/admin/rewards/stamps/notices/read" ||
              path === "/admin/rewards/stamps/bulk" ||
              path.endsWith("/adjustments")
            ? method === "POST"
            : path === "/admin/rewards/promotions"
              ? method === "GET" || method === "POST"
              : path.startsWith("/admin/rewards/promotions/")
                ? method === "PUT"
                : method === "GET";
      if (
        ((path === "/admin/portfolio" || path.startsWith("/admin/portfolio/")) &&
          !portfolioAllowed) ||
        (path.startsWith("/admin/clients/") && !clientDetailAllowed) ||
        (path.startsWith("/admin/accounting/") && !accountingAllowed) ||
        (path.startsWith("/admin/intake-forms") && !intakeAllowed) ||
        (path === "/admin/intake-forms" && method === "GET" && c.req.query("view") !== "summary") ||
        !DESKTOP_PROXY_ROUTE.test(path) ||
        (path.startsWith("/admin/rewards/") && !rewardsAllowed) ||
        (/^\/admin\/commerce\/checkouts\/[\da-f-]+\/reward(?:\/|$)/.test(path) &&
          method !== "POST") ||
        (path.startsWith("/admin/marketing/") &&
          (method === "GET" ? /\/(?:queue|cancel|test-email)$/.test(path) : !campaignMutation)) ||
        ((path === "/admin/gift-cards" || path.startsWith("/admin/gift-cards/")) &&
          !giftCardMethod) ||
        (method !== "POST" &&
          [
            "/appointments/desktop-booking",
            "/appointments/desktop-series",
            "/appointments/desktop-series/preview",
            "/appointments/desktop-visits",
            "/appointments/desktop-visits/preview",
          ].includes(path)) ||
        (path === "/admin/staff-accounts" && method !== "POST") ||
        (path === "/admin/accounts/lookup" && method !== "POST") ||
        (path === "/admin/accounts/role/reviewed" && method !== "PUT") ||
        (path.endsWith("/account-role/reviewed") && method !== "PUT") ||
        (path.startsWith("/admin/services/") &&
          method !==
            (path === "/admin/services/reviewed" || path.endsWith("/resources/reviewed")
              ? "GET"
              : "PUT")) ||
        (path === "/admin/whatsapp/rules/reviewed" && method !== "PATCH") ||
        (path === "/admin/whatsapp/disconnect/reviewed" && method !== "POST") ||
        (path === "/admin/email-delivery" && method !== "GET" && method !== "PUT") ||
        (path === "/admin/email-delivery/test-reviewed" && method !== "POST") ||
        (path === "/admin/settings/desktop" && method !== "GET" && method !== "PUT") ||
        (path === "/admin/settings/booking-policy/reviewed" &&
          method !== "GET" &&
          method !== "PUT") ||
        ([
          "/me",
          "/me/desktop-workspaces",
          "/admin/whatsapp/desk",
          "/admin/whatsapp/templates",
          "/admin/commerce/unpaid",
          "/admin/commerce/capabilities",
          "/admin/passes/eligible",
        ].includes(path) &&
          method !== "GET") ||
        (path.startsWith("/admin/inventory/") && !inventoryAllowed) ||
        (path === "/admin/passes/refund-quote" && method !== "POST") ||
        (path.startsWith("/admin/commerce/checkouts/") &&
          path.endsWith("/prices") &&
          method !== "PUT") ||
        ((path.startsWith("/admin/commerce/payments/") ||
          path.startsWith("/admin/commerce/refunds/") ||
          (path.startsWith("/admin/commerce/checkouts/") && path.endsWith("/void"))) &&
          method !== "POST") ||
        (path.startsWith("/admin/staff/") && path.includes("/date-shifts") && !dateShiftAllowed) ||
        (path.startsWith("/admin/staff/") &&
          (path.endsWith("/working-hours") || path.endsWith("/access/reviewed")) &&
          method !== "GET" &&
          method !== "PUT")
      )
        throw new DomainError("forbidden", "This route is outside desktop access");
      try {
        const identity = await desktop.verify(authorization);
        if (
          identity.clientId !== DESKTOP_CLIENT_ID ||
          !identity.scopes.includes(DESKTOP_SIGN_IN_SCOPE) ||
          identity.principal.role === "client"
        )
          throw new DomainError("forbidden", "A centre account is required");
        c.set("principal", identity.principal);
        c.set("desktopRequest", true);
      } catch (error) {
        if (!(error instanceof BearerError)) throw error;
        throw new DomainError("unauthorized", "Invalid desktop authorization");
      }
      await next();
      return;
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const principal = session ? await loadPrincipal(db, session.user.id) : null;
    if (!principal) throw new DomainError("unauthorized", "Authentication required");
    c.set("principal", principal);
    await next();
  };
}
