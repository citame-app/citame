import {
  type AdvanceInventoryNumbering,
  INVENTORY_NUMBER_MAX,
  type InventoryNumberingSeries,
  type InventoryNumberingSnapshot,
} from "@sob/contracts";
import { type Database, pgErrorCode, salonSettings } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";

const relations = { orders: "purchase_order", receipts: "stock_receipt" } as const;

async function seriesState(db: Pick<Database, "execute">, series: InventoryNumberingSeries) {
  const relation = relations[series];
  const [sequence] = await db.execute<{ name: string; schema: string; max: number }>(sql`
    select c.relname as name, n.nspname as schema, s.seqmax::integer as max
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_sequence s on s.seqrelid = c.oid
    where c.oid = pg_catalog.pg_get_serial_sequence(${`public.${relation}`}, 'number')::regclass
      and s.seqcache = 1 and s.seqincrement = 1 and not s.seqcycle
  `);
  if (!sequence || sequence.max !== INVENTORY_NUMBER_MAX)
    throw new DomainError("internal_error", "Document numbering is not configured");
  const [state] = await db.execute<{ prior: number; called: boolean; issued: number | null }>(sql`
    select last_value::integer as prior, is_called as called,
      (select max(number) from public.${sql.identifier(relation)}) as issued
    from ${sql.identifier(sequence.schema)}.${sql.identifier(sequence.name)}
  `);
  if (!state) throw new DomainError("internal_error", "Document numbering is not configured");
  const allocatedNext = state.prior + Number(state.called);
  const next = Math.max(allocatedNext, (state.issued ?? 0) + 1);
  return {
    allocatedNext,
    view: { nextNumber: next <= sequence.max ? next : null, lastIssuedNumber: state.issued },
  };
}

export async function reviewInventoryNumbering(
  db: Database,
  generation: string,
): Promise<InventoryNumberingSnapshot> {
  const [orders, receipts] = await Promise.all([
    seriesState(db, "orders"),
    seriesState(db, "receipts"),
  ]);
  return { generation, orders: orders.view, receipts: receipts.view };
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
    input.nextNumber > INVENTORY_NUMBER_MAX
  )
    throw new DomainError("validation_error", "Select a valid document number");
  const relation = sql`public.${sql.identifier(relations[series])}`;
  try {
    return await db.transaction(async (tx) => {
      // Inserting a document acquires a conflicting table lock before allocating its identity.
      // Take the same lock needed by ALTER up front, so the reviewed number cannot be consumed
      // between the check and the restart. NOWAIT keeps a settings save out of document writers' way.
      await tx.execute(sql`LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE NOWAIT`);
      const actor = await loadPrincipal(tx, principal.userId);
      if (!actor) throw new DomainError("forbidden", "The account is unavailable");
      requireRole(actor, "owner");
      const current = await seriesState(tx, series);
      if (current.view.nextNumber !== input.expectedNextNumber)
        throw new DomainError(
          "version_conflict",
          "The series changed. Review the next document number.",
        );
      if (input.nextNumber < input.expectedNextNumber)
        throw new DomainError("validation_error", "The next document number can only increase");
      if (input.nextNumber === current.allocatedNext) return current.view;
      // PostgreSQL utility statements do not accept bindings. Only an already checked integer
      // and the fixed relation map enter the DDL.
      await tx.execute(
        sql`ALTER TABLE ${relation} ALTER COLUMN number RESTART WITH ${sql.raw(String(input.nextNumber))}`,
      );
      await tx
        .update(salonSettings)
        .set({
          updatedAt: sql`greatest(clock_timestamp(), ${salonSettings.updatedAt} + interval '1 millisecond')`,
        })
        .where(eq(salonSettings.id, 1));
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "inventory.numbering_advanced",
        entity: "inventory_numbering",
        entityId: series,
        metadata: { oldNextNumber: current.allocatedNext, nextNumber: input.nextNumber },
      });
      return { ...current.view, nextNumber: input.nextNumber };
    });
  } catch (error) {
    if (pgErrorCode(error) === "55P03")
      throw new DomainError(
        "version_conflict",
        "The series is in use. Review it before trying again.",
      );
    throw error;
  }
}
