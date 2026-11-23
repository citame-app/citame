import { createHash } from "node:crypto";
import {
  type CombinationCreate,
  type CombinationUpdate,
  type FixedCombinationTerms,
  permissionsFor,
  type Service,
} from "@sob/contracts";
import { type Database, serviceCombination, staffProfile } from "@sob/db";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { activeServiceAssignments } from "../staff/service";
import { assertFixedCombinationCurrency } from "./combination-booking";
import { assertCatalogSelection } from "./options";
import {
  assertOnlineServices,
  getBookableServices,
  listServices,
  onlineServicesByIds,
} from "./service";

type Connection = Database | Tx;
type Row = typeof serviceCombination.$inferSelect;
type ActiveAssignments = Map<string, Set<string>>;

async function activeAssignments(
  db: Connection,
  ids: readonly string[],
): Promise<ActiveAssignments> {
  const byService: ActiveAssignments = new Map();
  for (const { serviceId, staffId } of await activeServiceAssignments(db, ids)) {
    const assigned = byService.get(serviceId) ?? new Set<string>();
    assigned.add(staffId);
    byService.set(serviceId, assigned);
  }
  return byService;
}

function hasQualifiedTeam(services: Service[], assignments: ActiveAssignments): boolean {
  const qualified = (ids: string[]) =>
    [...(assignments.get(ids[0] ?? "") ?? [])].some((staff) =>
      ids.every((id) => assignments.get(id)?.has(staff)),
    );
  if (qualified(services.map((row) => row.id))) return true;
  const parts: string[][] = [];
  for (const row of services) {
    if (row.catalog?.kind === "addon") parts.at(-1)?.push(row.id);
    else parts.push([row.id]);
  }
  return parts.length <= 8 && parts.every(qualified);
}

async function validate(
  db: Connection,
  ids: string[],
  requireOnline = false,
  fixed?: FixedCombinationTerms | null,
) {
  const services = await getBookableServices(db, ids);
  if (requireOnline) {
    try {
      await assertOnlineServices(db, ids);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "forbidden") throw error;
      throw new DomainError("validation_error", "Choose treatments available for online booking");
    }
  }
  if (fixed) {
    if (fixed.pricesCents.reduce((sum, cents) => sum + cents, 0) > 999_999_999)
      throw new DomainError(
        "validation_error",
        "The combination total exceeds the supported amount",
      );
    if (fixed.pricesCents.length !== services.length)
      throw new DomainError("validation_error", "Enter one price for each treatment in order");
    assertFixedCombinationCurrency(services);
    const members = await activeCombinationStaff(db, fixed.staffIds);
    if (members.length !== fixed.staffIds.length)
      throw new DomainError("not_found", "A professional for the combination is unavailable");
    return;
  }
  if (!hasQualifiedTeam(services, await activeAssignments(db, ids)))
    throw new DomainError(
      "validation_error",
      "Each treatment and its extras need a qualified professional",
    );
}
async function activeCombinationStaff(db: Connection, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: staffProfile.id })
    .from(staffProfile)
    .where(
      and(
        inArray(staffProfile.id, ids),
        eq(staffProfile.active, true),
        isNull(staffProfile.deletedAt),
      ),
    );
  return rows.map(({ id }) => id);
}

function fixedTerms(row: Row): FixedCombinationTerms | null {
  return row.fixedPricesCents && row.fixedStaffIds
    ? {
        pricesCents: Array.from(row.fixedPricesCents),
        staffIds: row.fixedStaffIds,
        ...(row.fixedOnlineBooking !== null ? { onlineBooking: row.fixedOnlineBooking } : {}),
      }
    : null;
}
async function writtenView(db: Connection, row: Row) {
  const fixed = fixedTerms(row);
  try {
    if (fixed) {
      if (!row.active || fixed.onlineBooking === undefined) return view(row, false);
      const staffIds = await activeCombinationStaff(db, fixed.staffIds);
      if (!staffIds.length) return view(row, false);
      await validate(db, row.serviceIds, fixed.onlineBooking, { ...fixed, staffIds });
    } else await validate(db, row.serviceIds, true);
    return view(row, true);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return view(row, false);
  }
}

function view(row: Row, bookable: boolean) {
  const fixed = fixedTerms(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    serviceIds: row.serviceIds,
    active: row.active,
    version: row.version,
    bookable,
    ...(fixed ? { fixedTerms: fixed } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listCombinations(db: Database, principal?: Principal, supportsFixed = false) {
  if (principal) requirePermission(principal, "editCatalog");
  return combinationCatalogue(db, { management: Boolean(principal), supportsFixed });
}

export async function bookingCombinationCatalogue(db: Database, principal: Principal) {
  requirePermission(principal, "editCalendar");
  const all = permissionsFor(principal.role, principal.accessPreset).allCalendars;
  if (!all && !principal.staffId) return { combinations: [] };
  return combinationCatalogue(db, {
    management: false,
    supportsFixed: true,
    staffOnlyCatalogue: true,
    staffId: all ? undefined : (principal.staffId ?? undefined),
  });
}

async function combinationCatalogue(
  db: Database,
  options: {
    management: boolean;
    supportsFixed: boolean;
    staffOnlyCatalogue?: boolean;
    staffId?: string;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const rows = await tx
      .select()
      .from(serviceCombination)
      .where(options.management ? undefined : eq(serviceCombination.active, true))
      .orderBy(asc(serviceCombination.name), asc(serviceCombination.id))
      .limit(100);
    if (!rows.length) return { combinations: [] };
    const ids = [...new Set(rows.flatMap((row) => row.serviceIds))];
    const services = new Map((await onlineServicesByIds(tx, ids)).map((row) => [row.id, row]));
    const internal =
      options.supportsFixed && (options.management || options.staffOnlyCatalogue)
        ? new Map((await listServices(tx, true)).map((row) => [row.id, row]))
        : services;
    const assignments = await activeAssignments(tx, ids);
    const fixedStaff = new Set(
      await activeCombinationStaff(
        tx,
        options.supportsFixed ? [...new Set(rows.flatMap((row) => row.fixedStaffIds ?? []))] : [],
      ),
    );
    return {
      combinations: rows.flatMap((row) => {
        const fixed = fixedTerms(row);
        if (!fixed && options.staffOnlyCatalogue) return [];
        if (fixed && !options.supportsFixed) return options.management ? [view(row, false)] : [];
        if (fixed?.onlineBooking === false && !options.management && !options.staffOnlyCatalogue)
          return [];
        const source = fixed?.onlineBooking === false ? internal : services;
        const selected: Service[] = [];
        for (const id of row.serviceIds) {
          const item = source.get(id);
          if (!item) return options.management ? [view(row, false)] : [];
          selected.push(item);
        }
        let bookable = false;
        try {
          assertCatalogSelection(selected);
          if (fixed) assertFixedCombinationCurrency(selected);
          bookable = fixed
            ? row.active &&
              fixed.onlineBooking !== undefined &&
              fixed.staffIds.some(
                (id) => fixedStaff.has(id) && (!options.staffId || options.staffId === id),
              )
            : hasQualifiedTeam(selected, assignments);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
        }
        return options.management || bookable ? [view(row, bookable)] : [];
      }),
    };
  });
}

export async function saveCombination(
  db: Database,
  input: CombinationCreate | CombinationUpdate,
  p: Principal,
  now: Date,
  target?: { kind: "create" | "update"; id: string; reviewOnline?: true },
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await loadPrincipal(tx, p.userId);
    if (!current) throw new DomainError("forbidden", "This account is no longer available");
    requirePermission(current, "editCatalog");
    const fields = {
      name: input.name,
      description: input.description,
      serviceIds: input.serviceIds,
      active: input.active,
    };
    let row: Row | undefined;
    const id = target?.kind === "update" ? target.id : undefined;
    if (id) {
      [row] = await tx
        .select()
        .from(serviceCombination)
        .where(eq(serviceCombination.id, id))
        .for("update");
      if (!row) throw new DomainError("not_found", "Combination not found");
      if (!("version" in input) || input.version !== row.version)
        throw new DomainError("version_conflict", "Combination changed; reload before saving");
      const selectionChanged = JSON.stringify(input.serviceIds) !== JSON.stringify(row.serviceIds);
      const stored = fixedTerms(row);
      if (stored?.onlineBooking === false && input.fixedTerms === null && input.active)
        throw new DomainError(
          "version_conflict",
          "Archive an internal combination before removing its fixed terms",
        );
      if (stored && input.fixedTerms === undefined && selectionChanged)
        throw new DomainError(
          "version_conflict",
          "Review the price and staff after changing the treatment order",
        );
      const fixed = input.fixedTerms === undefined ? stored : input.fixedTerms;
      if (
        input.active &&
        fixed &&
        (fixed.onlineBooking === undefined ||
          (!row.active && input.fixedTerms?.onlineBooking === undefined))
      )
        throw new DomainError(
          "version_conflict",
          "Choose the visibility before publishing the combination",
        );
      if (input.active || selectionChanged || input.fixedTerms)
        await validate(
          tx,
          input.serviceIds,
          fixed ? input.active && fixed.onlineBooking === true : target?.reviewOnline,
          fixed,
        );
      [row] = await tx
        .update(serviceCombination)
        .set({
          ...fields,
          fixedPricesCents: fixed?.pricesCents ?? null,
          fixedStaffIds: fixed?.staffIds ?? null,
          fixedOnlineBooking: fixed?.onlineBooking ?? null,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(serviceCombination.id, id))
        .returning();
    } else {
      if (!("idempotencyKey" in input))
        throw new DomainError("validation_error", "A creation identifier is required");
      const fixed = input.fixedTerms;
      if (input.active && fixed && fixed.onlineBooking === undefined)
        throw new DomainError(
          "validation_error",
          "Choose the visibility before publishing the combination",
        );
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(fixed ? { ...fields, fixedTerms: fixed } : fields))
        .digest("hex");
      [row] = await tx
        .select()
        .from(serviceCombination)
        .where(
          and(
            eq(serviceCombination.createdBy, p.userId),
            eq(serviceCombination.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (row) {
        if (row.requestFingerprint !== fingerprint || (target && row.id !== target.id))
          throw new DomainError("invalid_state", "This identifier belongs to another submission");
        return writtenView(tx, row);
      }
      if (target) {
        const [existing] = await tx
          .select({ id: serviceCombination.id })
          .from(serviceCombination)
          .where(eq(serviceCombination.id, target.id));
        if (existing)
          throw new DomainError("invalid_state", "This combination identifier already exists");
      }
      const [total] = await tx.select({ total: count() }).from(serviceCombination);
      if ((total?.total ?? 0) >= 100)
        throw new DomainError("storage_limit", "The salon combination limit has been reached");
      await validate(
        tx,
        input.serviceIds,
        fixed ? input.active && fixed.onlineBooking === true : target?.reviewOnline,
        fixed,
      );
      [row] = await tx
        .insert(serviceCombination)
        .values({
          ...fields,
          fixedPricesCents: fixed?.pricesCents ?? null,
          fixedStaffIds: fixed?.staffIds ?? null,
          fixedOnlineBooking: fixed?.onlineBooking ?? null,
          ...(target ? { id: target.id } : {}),
          createdBy: p.userId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }
    if (!row) throw new Error("Combination write returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: id ? "service_combination.update" : "service_combination.create",
      entity: "service_combination",
      entityId: row.id,
      metadata: { version: row.version, active: row.active, serviceIds: row.serviceIds },
    });
    return writtenView(tx, row);
  });
}
