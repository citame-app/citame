import type { UpdateProfileRequest } from "@sob/contracts";
import { clientProfile, type Database, user } from "@sob/db";
import { eq } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";

/** Phone number stored on the caller's booking profile, if they have one. */
export async function getPhone(
  db: Pick<Database, "select">,
  principal: Principal,
): Promise<string | null> {
  if (!principal.clientId) return null;
  const [row] = await db
    .select({ phone: clientProfile.phone })
    .from(clientProfile)
    .where(eq(clientProfile.id, principal.clientId));
  return row?.phone ?? null;
}

/**
 * Self-service profile edit. The name lives on the login and is mirrored to the booking profile;
 * the phone exists only on the booking profile, so accounts without one cannot store a phone.
 */
export async function updateProfile(
  db: Database,
  principal: Principal,
  request: UpdateProfileRequest,
): Promise<void> {
  if (request.phone !== undefined && !principal.clientId) {
    throw new DomainError("validation_error", "phone: this account has no booking profile");
  }
  await db.transaction(async (tx) => {
    if (request.name !== undefined) {
      await tx.update(user).set({ name: request.name }).where(eq(user.id, principal.userId));
    }
    if (principal.clientId) {
      const changes: { name?: string; phone?: string | null } = {};
      if (request.name !== undefined) changes.name = request.name;
      if (request.phone !== undefined) changes.phone = request.phone;
      if (Object.keys(changes).length > 0) {
        await tx.update(clientProfile).set(changes).where(eq(clientProfile.id, principal.clientId));
      }
    }
  });
}
