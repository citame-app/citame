import {
  type AdvanceInventoryNumbering,
  INVENTORY_NUMBER_MAX,
  type InventoryNumberingSeries,
  type InventoryNumberingSnapshot,
  inventoryNumberingStateSchema,
} from "@sob/contracts";
import { type Database, pgErrorCode } from "@sob/db";
import { sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";

type NumberingState = InventoryNumberingSnapshot["orders"];

async function seriesState(db: Database, series: InventoryNumberingSeries) {
  const [state] = await db.execute<NumberingState>(sql`
    select next_number as "nextNumber", last_issued_number as "lastIssuedNumber"
    from public.inventory_numbering_status(${series}::text)
  `);
  if (!state) throw new DomainError("internal_error", "Document numbering is not configured");
  return inventoryNumberingStateSchema.parse(state);
}

export async function reviewInventoryNumbering(
  db: Database,
  generation: string,
): Promise<InventoryNumberingSnapshot> {
  const [orders, receipts] = await Promise.all([
    seriesState(db, "orders"),
    seriesState(db, "receipts"),
  ]);
  return { generation, orders, receipts };
}

export async function advanceInventoryNumbering(
  db: Database,
  series: InventoryNumberingSeries,
  input: AdvanceInventoryNumbering,
  principal: Principal,
  generation: string,
) {
  requireRole(principal, "owner");
  if (input.generation !== generation)
    throw new DomainError(
      "version_conflict",
      "The database was restored. Review the current series.",
    );
  if (
    !Number.isInteger(input.nextNumber) ||
    input.nextNumber < 1 ||
    input.nextNumber > INVENTORY_NUMBER_MAX ||
    input.nextNumber < input.expectedNextNumber
  )
    throw new DomainError("validation_error", "The next document number can only increase");
  try {
    return await db.transaction(async (tx) => {
      const actor = await loadPrincipal(tx, principal.userId);
      if (!actor) throw new DomainError("forbidden", "The account is unavailable");
      requireRole(actor, "owner");
      const [change] = await tx.execute<
        NumberingState & { previousNumber: number; changed: boolean }
      >(sql`
        select previous_number as "previousNumber", next_number as "nextNumber",
          last_issued_number as "lastIssuedNumber", changed
        from public.inventory_numbering_advance(
          ${series}::text, ${input.expectedNextNumber}::integer, ${input.nextNumber}::integer
        )
      `);
      if (!change) throw new DomainError("internal_error", "Document numbering is not configured");
      if (change.changed) {
        await recordAudit(tx, {
          actorUserId: actor.userId,
          action: "inventory.numbering_advanced",
          entity: "inventory_numbering",
          entityId: series,
          metadata: { oldNextNumber: change.previousNumber, nextNumber: input.nextNumber },
        });
        // Use the same commit-ordered topic as inventory writes without modifying settings
        // revisions or creating a second event when an ordinary document is issued.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0))`);
        await tx.execute(sql`
          insert into sync_change (entity, row_id, op) values ('live_view', 'commerce', 'upsert')
        `);
      }
      return inventoryNumberingStateSchema.parse(change);
    });
  } catch (error) {
    if (pgErrorCode(error) === "PT409")
      throw new DomainError(
        "version_conflict",
        "The series changed. Review the next document number.",
      );
    if (pgErrorCode(error) === "55P03")
      throw new DomainError(
        "version_conflict",
        "The series is in use. Review it before trying again.",
      );
    throw error;
  }
}
