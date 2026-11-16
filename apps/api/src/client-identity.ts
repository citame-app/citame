import { clientProfile, type Database } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { DomainError } from "./errors";
import type { Tx } from "./tx";

type Connection = Pick<Database, "select">;
export async function clientIdentityIds(db: Connection, id: string) {
  const rows = await db
    .select({ id: clientProfile.id })
    .from(clientProfile)
    .where(sql`${clientProfile.id} in(select client_identity_ids(${id}::uuid))`);
  return rows.map((row) => row.id);
}
export async function clientRoot(db: Connection, id: string) {
  const [row] = await db
    .select()
    .from(clientProfile)
    .where(eq(clientProfile.id, sql`client_root_id(${id}::uuid)`));
  if (!row || row.deletedAt) throw new DomainError("not_found", "Client not found");
  return row;
}
/** Follow again after every row-lock wait: a concurrent merge may have changed the root. */
export async function lockClientRoot(tx: Tx, id: string, includeArchived = false) {
  let currentId = id;
  for (let depth = 0; depth < 20; depth++) {
    const [row] = await tx
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, currentId))
      .for("update");
    if (!row) throw new DomainError("not_found", "Client not found");
    if (row.mergedIntoId) {
      currentId = row.mergedIntoId;
      continue;
    }
    if (!includeArchived && row.deletedAt) throw new DomainError("not_found", "Client not found");
    return row;
  }
  throw new DomainError("invalid_state", "Client identity requires review");
}
/** New data must name the reviewed surviving profile, never silently change an old proposal. */
export function requireClientRoot(row: Pick<typeof clientProfile.$inferSelect, "mergedIntoId">) {
  if (row.mergedIntoId)
    throw new DomainError(
      "client_merged",
      "This profile was merged. Open the surviving profile and review a new proposal.",
    );
}
