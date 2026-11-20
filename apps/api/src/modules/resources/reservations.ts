import {
  type Database,
  resourcePool,
  resourceReservation,
  serviceResource,
  waitlistOffer,
} from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import {
  createResourceCalendar,
  createResourceCapacityCalendar,
  hasMixedCapacityConflict,
  type OccupiedUnit,
  type ResourceWindow,
  repackResourceUnits,
} from "./plan";

type Connection = Database | Tx;
export const IMPORTED_RESOURCE_UNIT_START = 20;
export type TimedService = {
  id: string;
  durationMinutes: number;
  bufferMinutes: number;
  position?: number;
  processing?: { startsAfterMinutes: number; minutes: number };
};
type Pool = typeof resourcePool.$inferSelect;
type Window = {
  position: number;
  offset: number;
  endOffset: number;
  quantity: number;
  name: string;
  alternative: boolean;
};
type Group = { pool: Pool; windows: Window[] };
const unavailable = () =>
  new DomainError(
    "slot_unavailable",
    "The required room or equipment has no capacity at this time",
  );
async function requirements(
  db: Connection,
  services: TimedService[],
  onlyServiceId?: string,
): Promise<Group[]> {
  if (services.length > 24)
    throw new DomainError("validation_error", "A visit can contain at most 24 services");
  const rows = await db
    .select({ link: serviceResource, pool: resourcePool })
    .from(serviceResource)
    .innerJoin(resourcePool, eq(resourcePool.id, serviceResource.resourceId))
    .where(
      inArray(
        serviceResource.serviceId,
        services.map((s) => s.id),
      ),
    );
  const groups = new Map<string, Group>();
  let offset = 0;
  for (const [position, service] of services.entries()) {
    const endOffset = offset + service.durationMinutes + service.bufferMinutes;
    for (const row of rows.filter(
      (r) => r.link.serviceId === service.id && (!onlyServiceId || service.id === onlyServiceId),
    )) {
      const group = groups.get(row.pool.id) ?? { pool: row.pool, windows: [] };
      group.windows.push({
        position: service.position ?? position,
        offset,
        endOffset,
        quantity: row.link.quantity,
        name: row.pool.name,
        alternative: row.link.alternative,
      });
      groups.set(row.pool.id, group);
    }
    offset = endOffset;
  }
  return [...groups.values()].sort((a, b) => a.pool.id.localeCompare(b.pool.id));
}

/** Service windows are sequential. Each alternative window needs a single eligible pool. */
function selectPools(
  groups: Group[],
  accepts: (pool: Pool, window: Window) => boolean,
): Group[] | null {
  const alternatives = new Set<number>();
  const selected = new Set<number>();
  const result: Group[] = [];
  for (const { pool, windows } of groups) {
    const chosen: Window[] = [];
    for (const window of windows) {
      if (window.alternative) {
        alternatives.add(window.position);
        if (selected.has(window.position) || !pool.active || !accepts(pool, window)) continue;
        selected.add(window.position);
      } else if (!pool.active || !accepts(pool, window)) {
        return null;
      }
      chosen.push(window);
    }
    if (chosen.length) result.push({ pool, windows: chosen });
  }
  return alternatives.size === selected.size ? result : null;
}

async function frozenRequirements(db: Connection, appointmentId: string): Promise<Group[]> {
  const rows = await db
    .select({ row: resourceReservation, pool: resourcePool })
    .from(resourceReservation)
    .innerJoin(resourcePool, eq(resourcePool.id, resourceReservation.resourceId))
    .where(
      and(
        eq(resourceReservation.appointmentId, appointmentId),
        eq(resourceReservation.active, true),
      ),
    );
  const groups = new Map<string, Group>();
  for (const { row, pool } of rows) {
    const group = groups.get(pool.id) ?? { pool, windows: [] };
    const samePosition = group.windows.find((window) => window.position === row.servicePosition);
    if (samePosition) samePosition.quantity++;
    else
      group.windows.push({
        position: row.servicePosition,
        offset: row.offsetMinutes,
        endOffset: row.endOffsetMinutes,
        quantity: 1,
        name: row.name,
        alternative: false,
      });
    groups.set(pool.id, group);
  }
  return [...groups.values()];
}
function absolute(windows: Window[], start: number): ResourceWindow[] {
  return windows.map((w) => ({
    position: w.position,
    start: start + w.offset * 60000,
    end: start + w.endOffset * 60000,
    quantity: w.quantity,
  }));
}
async function occupied(
  db: Connection,
  ids: string[],
  from: Date,
  to: Date,
  now: Date,
  excludeAppointmentId?: string,
) {
  if (!ids.length) return [];
  return db
    .select({ row: resourceReservation })
    .from(resourceReservation)
    .leftJoin(waitlistOffer, eq(waitlistOffer.id, resourceReservation.offerId))
    .where(
      and(
        inArray(resourceReservation.resourceId, ids),
        eq(resourceReservation.active, true),
        eq(resourceReservation.released, false),
        lt(resourceReservation.startsAt, to),
        gt(resourceReservation.endsAt, from),
        or(sql`${resourceReservation.appointmentId} is not null`, gt(waitlistOffer.expiresAt, now)),
        excludeAppointmentId
          ? or(
              isNull(resourceReservation.appointmentId),
              ne(resourceReservation.appointmentId, excludeAppointmentId),
            )
          : undefined,
      ),
    );
}
const busy = (rows: Awaited<ReturnType<typeof occupied>>, id: string): OccupiedUnit[] =>
  rows
    .filter((r) => r.row.resourceId === id)
    .map(({ row }) => ({
      unitIndex: row.unitIndex,
      start: row.startsAt.getTime(),
      end: row.endsAt.getTime(),
    }));

function availableUnits(capacity: number, windows: ResourceWindow[], occupied: OccupiedUnit[]) {
  const regular = occupied.filter((row) => row.unitIndex < IMPORTED_RESOURCE_UNIT_START);
  if (
    regular.length < occupied.length &&
    !createResourceCapacityCalendar(capacity, occupied)?.(windows)
  )
    return null;
  return createResourceCalendar(capacity, regular)?.(windows) ?? null;
}

/** Requires the salon scheduling lock; clears expired offer units without locking their queue entries. */
export async function releaseExpiredResourceOffers(tx: Tx, ids: string[], now: Date) {
  if (!ids.length) return;
  await tx
    .update(resourceReservation)
    .set({ released: true })
    .where(
      and(
        inArray(resourceReservation.resourceId, ids),
        eq(resourceReservation.active, true),
        sql`exists (select 1 from waitlist_offer o where o.id=${resourceReservation.offerId} and o.expires_at<=${now})`,
      ),
    );
}
export async function filterResourceAvailability<T extends { startsAt: Date; endsAt: Date }>(
  db: Connection,
  services: TimedService[],
  slots: T[],
  now: Date,
  excludeAppointmentId?: string,
): Promise<T[]> {
  if (!slots.length) return slots;
  const groups = excludeAppointmentId
    ? await frozenRequirements(db, excludeAppointmentId)
    : await requirements(db, services);
  if (!groups.length) return slots;
  const from = new Date(slots.reduce((n, s) => Math.min(n, s.startsAt.getTime()), Infinity));
  const to = new Date(slots.reduce((n, s) => Math.max(n, s.endsAt.getTime()), -Infinity));
  const rows = await occupied(
    db,
    groups.map((g) => g.pool.id),
    from,
    to,
    now,
    excludeAppointmentId,
  );
  const calendars = new Map(
    groups.map(({ pool }) => [
      pool.id,
      createResourceCapacityCalendar(pool.capacity, busy(rows, pool.id)),
    ]),
  );
  if (groups.every(({ windows }) => windows.every((window) => !window.alternative)))
    return slots.filter((slot) =>
      groups.every(({ pool, windows }) =>
        Boolean(
          pool.active && calendars.get(pool.id)?.(absolute(windows, slot.startsAt.getTime())),
        ),
      ),
    );
  return slots.filter((slot) =>
    Boolean(
      selectPools(groups, (pool, window) =>
        Boolean(calendars.get(pool.id)?.(absolute([window], slot.startsAt.getTime()))),
      ),
    ),
  );
}
/** The caller takes the scheduling lock before calendar locks. Owner-window triggers keep these units aligned. */
export async function reserveResources(
  tx: Tx,
  owner: { appointmentId?: string; offerId?: string; startsAt: Date; endsAt: Date },
  services: TimedService[],
  now: Date,
  options: { onlyServiceId?: string; repackRaw?: boolean } = {},
) {
  const groups = await requirements(tx, services, options.onlyServiceId);
  if (!groups.length) return;
  await releaseExpiredResourceOffers(
    tx,
    groups.map((g) => g.pool.id),
    now,
  );
  const rows = await occupied(
    tx,
    groups.map((g) => g.pool.id),
    owner.startsAt,
    owner.endsAt,
    now,
  );
  const occupancy = new Map(groups.map(({ pool }) => [pool.id, busy(rows, pool.id)]));
  const selected = selectPools(groups, (pool, window) => {
    if (!window.alternative) return true;
    const required = absolute([window], owner.startsAt.getTime());
    const existing = occupancy.get(pool.id) ?? [];
    return Boolean(
      owner.startsAt >= now || options.repackRaw
        ? createResourceCapacityCalendar(pool.capacity, existing)?.(required)
        : availableUnits(pool.capacity, required, existing),
    );
  });
  if (!selected) throw unavailable();
  const values: (typeof resourceReservation.$inferInsert)[] = [];
  const repack: string[] = [];
  for (const group of selected) {
    const windows = absolute(group.windows, owner.startsAt.getTime());
    const busyUnits = occupancy.get(group.pool.id) ?? [];
    let plan = availableUnits(group.pool.capacity, windows, busyUnits);
    if (
      options.repackRaw ||
      (!plan &&
        owner.startsAt >= now &&
        createResourceCapacityCalendar(group.pool.capacity, busyUnits)?.(windows))
    ) {
      plan = group.windows.flatMap((w) =>
        Array.from({ length: w.quantity }, (_, unitIndex) => ({ position: w.position, unitIndex })),
      );
      if (!options.repackRaw) repack.push(group.pool.id);
    }
    if (!plan) throw unavailable();
    for (const item of plan) {
      const window = group.windows.find((w) => w.position === item.position);
      if (!window) throw new Error("Missing resource service window");
      values.push({
        resourceId: group.pool.id,
        appointmentId: owner.appointmentId ?? null,
        offerId: owner.offerId ?? null,
        servicePosition: item.position,
        unitIndex: item.unitIndex,
        offsetMinutes: window.offset,
        endOffsetMinutes: window.endOffset,
        startsAt: new Date(owner.startsAt.getTime() + window.offset * 60000),
        endsAt: new Date(owner.startsAt.getTime() + window.endOffset * 60000),
        name: window.name,
      });
    }
  }
  if (values.length) {
    const inserted = await tx
      .insert(resourceReservation)
      .values(values)
      .returning({ id: resourceReservation.id });
    if (repack.length)
      await repackFutureResources(tx, repack, now, { flexibleIds: inserted.map((r) => r.id) });
  }
}
export async function applyUnitPlan(tx: Tx, plan: { id: string; unitIndex: number }[]) {
  if (!plan.length) return;
  const clauses = sql.join(
    plan.map((p) => sql`when ${p.id}::uuid then ${p.unitIndex}::int`),
    sql` `,
  );
  await tx
    .update(resourceReservation)
    .set({
      unitIndex: sql`case ${resourceReservation.id} ${clauses} else ${resourceReservation.unitIndex} end`,
    })
    .where(
      inArray(
        resourceReservation.id,
        plan.map((p) => p.id),
      ),
    );
}
/** Moving a visit preserves its frozen resources and quantities; only interchangeable units may change. */
export async function reassignAppointmentResources(tx: Tx, id: string, now: Date) {
  const own = await tx
    .select()
    .from(resourceReservation)
    .where(and(eq(resourceReservation.appointmentId, id), eq(resourceReservation.active, true)))
    .orderBy(asc(resourceReservation.resourceId), asc(resourceReservation.id))
    .for("update");
  if (!own.length) return;
  const ids = [...new Set(own.map((r) => r.resourceId))];
  await releaseExpiredResourceOffers(tx, ids, now);
  const pools = await tx.select().from(resourcePool).where(inArray(resourcePool.id, ids));
  const from = new Date(Math.min(...own.map((r) => r.startsAt.getTime())));
  const to = new Date(Math.max(...own.map((r) => r.endsAt.getTime())));
  const rows = await occupied(tx, ids, from, to, now, id);
  const assignments: { id: string; unitIndex: number }[] = [];
  const repack: string[] = [];
  for (const resourceId of ids) {
    const pool = pools.find((p) => p.id === resourceId);
    if (!pool?.active) throw unavailable();
    const selected = own.filter((r) => r.resourceId === resourceId);
    const grouped = new Map<number, ResourceWindow>();
    for (const row of selected) {
      const group = grouped.get(row.servicePosition) ?? {
        position: row.servicePosition,
        start: row.startsAt.getTime(),
        end: row.endsAt.getTime(),
        quantity: 0,
      };
      group.quantity++;
      grouped.set(row.servicePosition, group);
    }
    const windows = [...grouped.values()];
    const busyUnits = busy(rows, resourceId);
    let plan = availableUnits(pool.capacity, windows, busyUnits);
    if (
      !plan &&
      from >= now &&
      createResourceCapacityCalendar(pool.capacity, busyUnits)?.(windows)
    ) {
      plan = [...grouped.values()].flatMap((w) =>
        Array.from({ length: w.quantity }, (_, unitIndex) => ({ position: w.position, unitIndex })),
      );
      repack.push(resourceId);
    }
    if (!plan) throw unavailable();
    for (const [position] of grouped) {
      const records = selected.filter((r) => r.servicePosition === position);
      const units = plan.filter((p) => p.position === position);
      for (const [i, row] of records.entries()) {
        const unit = units[i];
        if (!unit) throw new Error("Missing moved resource unit");
        assignments.push({ id: row.id, unitIndex: unit.unitIndex });
      }
    }
  }
  await applyUnitPlan(tx, assignments);
  if (repack.length)
    await repackFutureResources(tx, repack, now, { flexibleIds: own.map((r) => r.id) });
}
export async function calendarResources(db: Connection, appointmentIds: string[]) {
  const result = new Map<string, { name: string; quantity: number }[]>();
  if (!appointmentIds.length) return result;
  const rows = await db
    .select()
    .from(resourceReservation)
    .where(inArray(resourceReservation.appointmentId, appointmentIds));
  for (const id of appointmentIds) {
    const groups = new Map<string, { name: string; counts: Map<number, number> }>();
    for (const row of rows.filter((r) => r.appointmentId === id)) {
      const value = groups.get(row.resourceId) ?? { name: row.name, counts: new Map() };
      value.counts.set(row.servicePosition, (value.counts.get(row.servicePosition) ?? 0) + 1);
      groups.set(row.resourceId, value);
    }
    if (groups.size)
      result.set(
        id,
        [...groups.values()].map((g) => ({
          name: g.name,
          quantity: Math.max(...g.counts.values()),
        })),
      );
  }
  return result;
}

/** Recolour future interchangeable units only; units currently in use keep their assignment. */
export async function repackFutureResources(
  tx: Tx,
  ids: string[],
  now: Date,
  options: { capacities?: Map<string, number>; flexibleIds?: string[] } = {},
) {
  if (!ids.length) return;
  await releaseExpiredResourceOffers(tx, ids, now);
  const pools = await tx.select().from(resourcePool).where(inArray(resourcePool.id, ids));
  const rows = await tx
    .select()
    .from(resourceReservation)
    .where(
      and(
        inArray(resourceReservation.resourceId, ids),
        eq(resourceReservation.active, true),
        gt(resourceReservation.endsAt, now),
      ),
    )
    .orderBy(
      asc(resourceReservation.resourceId),
      asc(resourceReservation.startsAt),
      asc(resourceReservation.id),
    )
    .for("update");
  const plan: { id: string; unitIndex: number }[] = [];
  const flexible = new Set(options.flexibleIds ?? []);
  for (const resourceId of ids) {
    const pool = pools.find((p) => p.id === resourceId);
    if (!pool) throw unavailable();
    const capacity = options.capacities?.get(resourceId) ?? pool.capacity;
    const active = rows.filter((r) => r.resourceId === resourceId);
    const own = active.filter((r) => r.unitIndex < IMPORTED_RESOURCE_UNIT_START);
    if (
      own.length < active.length &&
      hasMixedCapacityConflict(
        capacity,
        active.map((row) => ({
          start: Math.max(row.startsAt.getTime(), now.getTime()),
          end: row.endsAt.getTime(),
          historical: row.unitIndex >= IMPORTED_RESOURCE_UNIT_START,
        })),
      )
    )
      throw unavailable();
    const fixed = own.filter((r) => r.startsAt <= now && !flexible.has(r.id));
    const future = own.filter((r) => r.startsAt > now || flexible.has(r.id));
    const assignment = repackResourceUnits(
      capacity,
      future.map((r) => ({ id: r.id, start: r.startsAt.getTime(), end: r.endsAt.getTime() })),
      fixed.map((r) => ({
        unitIndex: r.unitIndex,
        start: r.startsAt.getTime(),
        end: r.endsAt.getTime(),
      })),
    );
    if (!assignment) throw unavailable();
    for (const item of assignment) {
      if (own.find((r) => r.id === item.id)?.unitIndex !== item.unitIndex) plan.push(item);
    }
  }
  await applyUnitPlan(tx, plan);
}
