import type { UserRole } from "@sob/contracts";
import { account, clientProfile, type Database, pgErrorCode, staffProfile, user } from "@sob/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { DomainError } from "../errors";
import type { Auth } from "./auth";

const UNIQUE_VIOLATION = "23505";
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AccountDeps {
  auth: Auth;
  db: Database;
}

export interface CreateAccountInput {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  /** Name shown in the booking flow for staff accounts; defaults to `name`. */
  displayName?: string;
}

/** When present, the change is recorded in the audit log inside the same transaction. */
export interface AuditContext {
  actorUserId: string | null;
  action: string;
}

export interface AccountResult {
  userId: string;
  role: UserRole;
  staffId: string | null;
  clientId: string | null;
}

function assertPasswordPolicy(password: string) {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new DomainError(
      "validation_error",
      `Password must be between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters`,
    );
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Returns the id of the user's calendar profile, creating or reviving it as needed. */
async function ensureStaffProfile(tx: Tx, userId: string, displayName: string): Promise<string> {
  const [existing] = await tx.select().from(staffProfile).where(eq(staffProfile.userId, userId));
  if (existing) {
    await tx
      .update(staffProfile)
      .set({ active: true, deletedAt: null })
      .where(eq(staffProfile.id, existing.id));
    return existing.id;
  }
  const [created] = await tx
    .insert(staffProfile)
    .values({ displayName, userId })
    .returning({ id: staffProfile.id });
  if (!created) throw new Error("Staff profile insert returned no row");
  return created.id;
}

async function ensureClientProfile(
  tx: Tx,
  userId: string,
  name: string,
  email: string,
): Promise<string> {
  const [existing] = await tx.select().from(clientProfile).where(eq(clientProfile.userId, userId));
  if (existing) {
    if (existing.deletedAt) {
      await tx
        .update(clientProfile)
        .set({ deletedAt: null })
        .where(eq(clientProfile.id, existing.id));
    }
    return existing.id;
  }
  const [created] = await tx
    .insert(clientProfile)
    .values({ name, email, userId })
    .returning({ id: clientProfile.id });
  if (!created) throw new Error("Client profile insert returned no row");
  return created.id;
}

/**
 * Creates a login (user + credential account) with a role and the profile that role needs,
 * atomically. Used by the owner-only staff endpoint and the owner bootstrap; the public
 * sign-up path goes through Better Auth and can only ever produce clients.
 */
export async function createAccount(
  { auth, db }: AccountDeps,
  input: CreateAccountInput,
  audit?: AuditContext,
): Promise<AccountResult> {
  assertPasswordPolicy(input.password);
  const email = normalizeEmail(input.email);
  const hash = await (await auth.$context).password.hash(input.password);

  try {
    return await db.transaction(async (tx) => {
      const userId = Bun.randomUUIDv7();
      await tx.insert(user).values({ id: userId, name: input.name, email, role: input.role });
      await tx.insert(account).values({
        id: Bun.randomUUIDv7(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hash,
      });
      const staffId =
        input.role === "staff"
          ? await ensureStaffProfile(tx, userId, input.displayName ?? input.name)
          : null;
      const clientId =
        input.role === "client" ? await ensureClientProfile(tx, userId, input.name, email) : null;
      if (audit) {
        await recordAudit(tx, {
          actorUserId: audit.actorUserId,
          action: audit.action,
          entity: "user",
          entityId: userId,
          metadata: { email, role: input.role, staffId, clientId },
        });
      }
      return { userId, role: input.role, staffId, clientId };
    });
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      throw new DomainError("invalid_state", "An account with this email already exists");
    }
    throw error;
  }
}

/**
 * Changes a user's role and keeps the profiles consistent: staff get an active calendar,
 * clients get a booking profile, and a demoted staff calendar is deactivated so it cannot be
 * booked any more. Existing profiles (and the appointments pointing at them) are never deleted.
 * Sessions need no invalidation: the role is read from the database on every request.
 */
export async function assignRole(
  db: Database,
  userId: string,
  role: UserRole,
  audit?: Pick<AuditContext, "actorUserId">,
): Promise<AccountResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(user).where(eq(user.id, userId));
    if (!row) throw new DomainError("not_found", `User ${userId} not found`);

    await tx.update(user).set({ role }).where(eq(user.id, userId));

    if (role === "staff") await ensureStaffProfile(tx, userId, row.name);
    if (role === "client") {
      await ensureClientProfile(tx, userId, row.name, row.email);
      await tx.update(staffProfile).set({ active: false }).where(eq(staffProfile.userId, userId));
    }

    const [staff] = await tx
      .select({ id: staffProfile.id })
      .from(staffProfile)
      .where(eq(staffProfile.userId, userId));
    const [client] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(eq(clientProfile.userId, userId)));
    if (audit) {
      await recordAudit(tx, {
        actorUserId: audit.actorUserId,
        action: "user.role_change",
        entity: "user",
        entityId: userId,
        metadata: { from: row.role, to: role },
      });
    }
    return { userId, role, staffId: staff?.id ?? null, clientId: client?.id ?? null };
  });
}

/**
 * Idempotent first-owner creation. Existing owner: no-op (credentials are never overwritten).
 * Existing non-owner with the same email: refused, because anyone could have pre-registered
 * that address through public sign-up and would otherwise inherit the owner role.
 */
export async function bootstrapOwner(
  deps: AccountDeps,
  input: { email: string; password: string; name: string },
): Promise<{ created: boolean; userId: string }> {
  assertPasswordPolicy(input.password);
  const email = normalizeEmail(input.email);

  const existing = async () => {
    const [row] = await deps.db.select().from(user).where(eq(user.email, email));
    return row;
  };
  const check = (row: Awaited<ReturnType<typeof existing>>) => {
    if (!row) return null;
    if (row.role !== "owner") {
      throw new DomainError(
        "invalid_state",
        `An account for ${email} already exists with role ${row.role}; refusing to promote it. ` +
          "Remove it or change its role in the database, then run the bootstrap again.",
      );
    }
    return { created: false, userId: row.id };
  };

  const already = check(await existing());
  if (already) return already;

  try {
    const created = await createAccount(
      deps,
      { ...input, email, role: "owner" },
      { actorUserId: null, action: "owner.bootstrap" },
    );
    return { created: true, userId: created.userId };
  } catch (error) {
    // Lost a race with a concurrent bootstrap: treat the winner's account as ours.
    if (error instanceof DomainError && error.code === "invalid_state") {
      const winner = check(await existing());
      if (winner) return winner;
    }
    throw error;
  }
}

/** Reads the first-owner credentials from the environment; never includes values in errors. */
export function ownerFromEnv(env: Record<string, string | undefined>) {
  const email = env.OWNER_EMAIL?.trim();
  const password = env.OWNER_PASSWORD;
  if (!email) throw new DomainError("validation_error", "OWNER_EMAIL is required");
  if (!password) throw new DomainError("validation_error", "OWNER_PASSWORD is required");
  if (!z.email().safeParse(email).success) {
    throw new DomainError("validation_error", "OWNER_EMAIL is not a valid email address");
  }
  return { email, password, name: env.OWNER_NAME?.trim() || "Owner" };
}
