import { type ClientControls, type ClientControlsInput, permissionsFor } from "@sob/contracts";
import { clientProfile, type Database } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { requireClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Connection = Database | Tx;
async function row(db: Connection, id: string, lock = false) {
  const query = db
    .select()
    .from(clientProfile)
    .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)));
  const [value] = await (lock ? query.for("update") : query);
  if (!value) throw new DomainError("not_found", "Client not found");
  return value;
}
function view(value: typeof clientProfile.$inferSelect, p: Principal): ClientControls {
  return {
    clientId: value.id,
    tags: value.tags,
    bookingAccess: value.bookingAccess as ClientControls["bookingAccess"],
    reason: value.bookingAccessReason,
    version: value.controlsVersion,
    canManageBookingAccess: permissionsFor(p.role, p.accessPreset).deleteClients,
  };
}
export async function getClientControls(db: Database, id: string, p: Principal) {
  requirePermission(p, "clients");
  return view(await row(db, id), p);
}
export async function updateClientControls(
  db: Database,
  id: string,
  input: ClientControlsInput,
  p: Principal,
) {
  requirePermission(p, "editClients");
  if (input.bookingAccess !== undefined) requirePermission(p, "deleteClients");
  return db.transaction(async (tx) => {
    const current = await row(tx, id, true);
    requireClientRoot(current);
    if (current.controlsVersion !== input.version)
      throw new DomainError("version_conflict", "Client controls changed; reload before saving");
    const [saved] = await tx
      .update(clientProfile)
      .set({
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.bookingAccess !== undefined
          ? { bookingAccess: input.bookingAccess, bookingAccessReason: input.reason }
          : {}),
        controlsVersion: current.controlsVersion + 1,
        updatedAt: current.updatedAt,
      })
      .where(eq(clientProfile.id, id))
      .returning();
    if (!saved) throw new Error("Client control update failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "client.controls_updated",
      entity: "client",
      entityId: id,
      metadata: {
        changed: [
          ...(input.tags !== undefined ? ["tags"] : []),
          ...(input.bookingAccess !== undefined ? ["bookingAccess"] : []),
        ],
        version: saved.controlsVersion,
      },
    });
    return view(saved, p);
  });
}
/** Shared by REST, delegated MCP and offline replay via the appointment domain service. */
export async function assertClientCanBook(tx: Tx, id: string, requireSurvivingProfile = false) {
  let currentId = id;
  for (let depth = 0; depth < 20; depth++) {
    const client = await row(tx, currentId, true);
    if (client.mergedIntoId) {
      if (requireSurvivingProfile) requireClientRoot(client);
      currentId = client.mergedIntoId;
      continue;
    }
    if (client.bookingAccess === "blocked")
      throw new DomainError(
        "forbidden",
        "This profile cannot book or move appointments. Contact the salon.",
      );
    return;
  }
  throw new DomainError("invalid_state", "Invalid client identity group");
}
