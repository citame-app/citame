import type { CreateStaffAccountRequest, StaffAccountResponse, UserRole } from "@sob/contracts";
import { account, clientProfile, type Database, pgErrorCode, staffProfile, user } from "@sob/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AppConfig } from "../config";
import { DomainError } from "../errors";
import { getReviewedStaffAccess } from "../modules/staff/access";
import { assertNoFutureAppointments } from "../modules/staff/guards";
import { localeFromRequest } from "../notifications/auth-emails";
import { lockCalendars } from "../tx";
import { type Auth, INVITE_LINK_SECONDS } from "./auth";
import { enqueueAccountEmail } from "./outbox";
import { createStaffInvitation } from "./secondary-storage";

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
  /** Omitted for an invitation: the person chooses their own from the emailed link. */
  password?: string;
  role: UserRole;
  /**
   * The server vouches for the address (owner bootstrap, owner-created accounts with a password).
   * Defaults to true when a password is given and false for an invitation, which becomes
   * verified when the invitee follows the link.
   */
  emailVerified?: boolean;
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
  /** True when no password was given and the login waits for the invitee to choose one. */
  invited: boolean;
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
  { auth, db }: { auth: Auth; db: Database | Tx },
  input: CreateAccountInput,
  audit?: AuditContext,
  existingStaff?: { id: string; version: number },
): Promise<AccountResult> {
  const invited = input.password === undefined;
  // An invited account gets a random, never-disclosed password: it can only be replaced through
  // the emailed link, and a credential row exists for the reset to update.
  const secret =
    input.password ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  assertPasswordPolicy(secret);
  const email = normalizeEmail(input.email);
  const hash = await (await auth.$context).password.hash(secret);
  const emailVerified = input.emailVerified ?? !invited;

  try {
    return await db.transaction(async (tx) => {
      const userId = Bun.randomUUIDv7();
      await tx
        .insert(user)
        .values({ id: userId, name: input.name, email, role: input.role, emailVerified });
      await tx.insert(account).values({
        id: Bun.randomUUIDv7(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hash,
      });
      const staffId =
        input.role === "staff"
          ? existingStaff
            ? await linkStaffProfile(tx, userId, existingStaff)
            : await ensureStaffProfile(tx, userId, input.displayName ?? input.name)
          : null;
      const clientId =
        input.role === "client" ? await ensureClientProfile(tx, userId, input.name, email) : null;
      if (audit) {
        await recordAudit(tx, {
          actorUserId: audit.actorUserId,
          action: audit.action,
          entity: "user",
          entityId: userId,
          metadata: { email, role: input.role, staffId, clientId, invited },
        });
      }
      return { userId, role: input.role, staffId, clientId, invited };
    });
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      throw new DomainError("invalid_state", "An account with this email already exists");
    }
    throw error;
  }
}

async function linkStaffProfile(tx: Tx, userId: string, reviewed: { id: string; version: number }) {
  const [linked] = await tx
    .update(staffProfile)
    .set({ userId, accessVersion: reviewed.version + 1 })
    .where(
      and(
        eq(staffProfile.id, reviewed.id),
        eq(staffProfile.accessVersion, reviewed.version),
        isNull(staffProfile.userId),
        isNull(staffProfile.deletedAt),
      ),
    )
    .returning({ id: staffProfile.id });
  if (!linked)
    throw new DomainError("version_conflict", "The staff calendar changed; reload before linking");
  return linked.id;
}

export async function provisionStaffAccount(
  { auth, db }: AccountDeps,
  config: Pick<AppConfig, "notifications" | "syncReplicaGeneration">,
  input: CreateStaffAccountRequest,
  actorUserId: string,
  request: Request,
): Promise<StaffAccountResponse> {
  const { existingCalendar, newCalendar } = input;
  const reviewedGeneration = (existingCalendar ?? newCalendar)?.generation;
  if (reviewedGeneration !== undefined && reviewedGeneration !== config.syncReplicaGeneration)
    throw new DomainError(
      "sync_generation_changed",
      "The centre was restored; review the calendar",
    );
  if (input.password === undefined && !auth.mailer.enabled)
    throw new DomainError("email_unavailable", "Configure an email provider before inviting staff");
  const email = normalizeEmail(input.email);
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, actorUserId))
      .for("share");
    if (actor?.role !== "owner")
      throw new DomainError("forbidden", "Only the owner can create staff accounts");
    const created = await createAccount(
      { auth, db: tx },
      { ...input, email, role: "staff" },
      { actorUserId, action: existingCalendar ? "staff.account_linked" : "staff.create" },
      existingCalendar
        ? { id: existingCalendar.staffId, version: existingCalendar.version }
        : undefined,
    );
    if (!created.staffId) throw new Error("Staff account was created without a calendar");
    if (created.invited)
      await queueStaffInvitation(tx, auth, config, { userId: created.userId, email }, request);
    return {
      userId: created.userId,
      staffId: created.staffId,
      email,
      role: "staff" as const,
      invited: created.invited,
      ...(reviewedGeneration !== undefined && {
        reviewedAccess: await getReviewedStaffAccess(
          tx,
          created.staffId,
          actor,
          config.syncReplicaGeneration,
        ),
      }),
    };
  });
  if (result.invited) auth.mailer.notifyQueued();
  return result;
}

async function queueStaffInvitation(
  tx: Tx,
  auth: Auth,
  config: Pick<AppConfig, "notifications">,
  target: { userId: string; email: string },
  request?: Request,
): Promise<void> {
  const ctx = await auth.$context;
  const token = await createStaffInvitation(
    tx,
    target.userId,
    new Date(Date.now() + INVITE_LINK_SECONDS * 1000),
  );
  const callback = encodeURIComponent("/reset-password?invited=1");
  const queued = await enqueueAccountEmail(tx, config.notifications.signingSecret, {
    kind: "staff_invite",
    to: target.email,
    url: `${ctx.baseURL}/reset-password/${token}?callbackURL=${callback}`,
    locale: localeFromRequest(request, config.notifications.defaultLocale),
    expiresInMinutes: INVITE_LINK_SECONDS / 60,
    idempotencyKey: `staff_invite:${target.userId}`,
  });
  if (queued !== "queued")
    throw new DomainError("rate_limited", "An invitation was recently queued for this email");
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
  audit?: { actorUserId: string },
  options: { now?: Date } = {},
): Promise<AccountResult> {
  return db.transaction(async (tx) => {
    // Demoting to client deactivates the calendar, which must not strand upcoming bookings.
    if (role === "client") {
      const [calendar] = await tx
        .select({ id: staffProfile.id })
        .from(staffProfile)
        .where(
          and(
            eq(staffProfile.userId, userId),
            eq(staffProfile.active, true),
            isNull(staffProfile.deletedAt),
          ),
        );
      if (calendar) {
        await lockCalendars(tx, [calendar.id]);
        await assertNoFutureAppointments(tx, calendar.id, options.now ?? new Date());
      }
    }

    const accounts = await tx
      .select()
      .from(user)
      .where(inArray(user.id, audit ? [userId, audit.actorUserId] : [userId]))
      .orderBy(asc(user.id))
      .for("no key update");
    if (audit && accounts.find((row) => row.id === audit.actorUserId)?.role !== "owner")
      throw new DomainError("forbidden", "Only the owner can change account roles");
    const row = accounts.find((account) => account.id === userId);
    if (!row) throw new DomainError("not_found", `User ${userId} not found`);
    await tx.update(user).set({ role }).where(eq(user.id, userId));

    if (role === "staff") await ensureStaffProfile(tx, userId, row.name);
    if (role === "client") {
      await ensureClientProfile(tx, userId, row.name, row.email);
      await tx.update(staffProfile).set({ active: false }).where(eq(staffProfile.userId, userId));
    }
    if (row.role !== role) {
      await tx
        .update(staffProfile)
        .set({ accessVersion: sql`${staffProfile.accessVersion} + 1` })
        .where(eq(staffProfile.userId, userId));
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
    return {
      userId,
      role,
      staffId: staff?.id ?? null,
      clientId: client?.id ?? null,
      invited: false,
    };
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
