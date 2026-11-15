import type { StaffAccessPreset, UserRole } from "@sob/contracts";
import { clientProfile, type Database, staffProfile, user } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { DomainError } from "../errors";
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
}

export type AppEnv = { Variables: { principal: Principal } };

/**
 * Resolves a principal from the database. The role is read here on every request instead of
 * trusting the cached session payload, so a role change takes effect immediately even though
 * sessions live in Valkey for days.
 */
export async function loadPrincipal(db: Database, userId: string): Promise<Principal | null> {
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

  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    staffId: staff?.id ?? null,
    accessPreset: staff?.accessPreset,
    clientId: client?.id ?? null,
  };
}

/** Requires a valid session cookie and exposes the principal as `c.get("principal")`. */
export function requireAuth(auth: Auth, db: Database): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const principal = session ? await loadPrincipal(db, session.user.id) : null;
    if (!principal) throw new DomainError("unauthorized", "Authentication required");
    c.set("principal", principal);
    await next();
  };
}
