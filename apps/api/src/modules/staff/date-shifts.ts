import { createHash } from "node:crypto";
import {
  type DateShiftCommit,
  type DateShiftDay,
  type DateShiftInput,
  type DateShiftPreview,
  type DateShiftRange,
  dateShiftRangesSchema,
  expandShiftTargets,
  shiftDate,
  type WorkingRange,
} from "@sob/contracts";
import {
  appointment,
  type Database,
  dateShift,
  dateShiftBatch,
  timeOff,
  waitlistOffer,
  workingHours,
} from "@sob/db";
import { and, asc, count, eq, gt, gte, isNull, lt, ne } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeStaffScheduleRead, requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { bookingViolations, findConflicts } from "../availability/rules";
import { getSalonSettings } from "../settings/service";
import { requireStaff } from "./admin";
import { asDatedHours, loadShiftRows, shiftDay } from "./date-hours";

type Connection = Database | Tx;
const canonical = (value: unknown): unknown =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const dateOf = (instant: Date, timezone: string) =>
  Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
const dayStart = (date: string, timezone: string) =>
  new Date(Temporal.PlainDate.from(date).toZonedDateTime(timezone).epochMilliseconds);
async function hours(db: Pick<Database, "select">, staffId: string): Promise<WorkingRange[]> {
  const rows = await db
    .select()
    .from(workingHours)
    .where(and(eq(workingHours.staffId, staffId), isNull(workingHours.deletedAt)))
    .orderBy(asc(workingHours.weekday), asc(workingHours.startTime), asc(workingHours.id));
  return rows.map((row) => ({
    weekday: row.weekday,
    startTime: row.startTime.slice(0, 5),
    endTime: row.endTime.slice(0, 5),
  }));
}
async function currentPrincipal(tx: Tx, principal: Principal) {
  const current = await loadPrincipal(tx, principal.userId);
  if (!current) throw new DomainError("forbidden", "This account is no longer available");
  requirePermission(current, "editSchedules");
  return current;
}
function targets(selection: DateShiftInput) {
  return selection.mode === "edit"
    ? selection.changes.map((change) => change.date).sort()
    : expandShiftTargets(selection)
        .map((pair) => pair.target)
        .sort();
}
function validateWindow(dates: string[], timezone: string, now: Date) {
  const today = dateOf(now, timezone);
  const last = shiftDate(today, 730);
  if (dates.some((date) => date < today || date > last))
    throw new DomainError(
      "validation_error",
      "Choose target dates from today through the next two years",
    );
}
function validTime(date: string, ranges: DateShiftRange[] | null, timezone: string) {
  for (const range of ranges ?? [])
    for (const time of [range.startTime, range.endTime]) {
      const value = Temporal.PlainDate.from(date).toZonedDateTime({
        timeZone: timezone,
        plainTime: time,
      });
      if (
        value.toPlainDate().toString() !== date ||
        value.toPlainTime().toString().slice(0, 5) !== time
      )
        throw new DomainError(
          "validation_error",
          `The time ${time} does not exist on ${date} in the salon timezone`,
        );
    }
}
async function context(db: Connection, staffId: string, dates: string[], now: Date) {
  const settings = await getSalonSettings(db);
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new DomainError("validation_error", "Choose at least one date");
  const from = dayStart(first, settings.timezone);
  const to = dayStart(shiftDate(last, 1), settings.timezone);
  const [weekly, rows, visits, offers, offs] = await Promise.all([
    hours(db, staffId),
    loadShiftRows(db, [staffId], first, last),
    db
      .select()
      .from(appointment)
      .where(
        and(
          eq(appointment.staffId, staffId),
          isNull(appointment.deletedAt),
          ne(appointment.status, "cancelled"),
          gt(appointment.endsAt, now),
          gte(appointment.startsAt, from),
          lt(appointment.startsAt, to),
        ),
      )
      .orderBy(asc(appointment.id))
      .limit(5001),
    db
      .select()
      .from(waitlistOffer)
      .where(
        and(
          eq(waitlistOffer.staffId, staffId),
          eq(waitlistOffer.state, "offered"),
          gt(waitlistOffer.expiresAt, now),
          gte(waitlistOffer.startsAt, from),
          lt(waitlistOffer.startsAt, to),
        ),
      )
      .orderBy(asc(waitlistOffer.id))
      .limit(5001),
    db
      .select()
      .from(timeOff)
      .where(
        and(
          eq(timeOff.staffId, staffId),
          isNull(timeOff.deletedAt),
          lt(timeOff.startsAt, to),
          gt(timeOff.endsAt, from),
        ),
      )
      .orderBy(asc(timeOff.id))
      .limit(5001),
  ]);
  if (visits.length > 5000 || offers.length > 5000 || offs.length > 5000)
    throw new DomainError(
      "storage_limit",
      "Review a smaller date window with fewer scheduled records",
    );
  const selected = new Set(dates);
  return {
    settings,
    weekly,
    rows,
    visits: visits.filter((visit) => selected.has(dateOf(visit.startsAt, settings.timezone))),
    offers: offers.filter((offer) => selected.has(dateOf(offer.startsAt, settings.timezone))),
    offs,
  };
}
function conflictsFor(
  state: Awaited<ReturnType<typeof context>>,
  proposed: DateShiftDay[],
  now: Date,
) {
  const rows = [
    ...state.rows.filter((row) => !proposed.some((day) => day.date === row.date)),
    ...proposed.map((day) => ({
      date: day.date,
      ranges: day.ranges,
      staffId: "",
      id: "",
      version: day.version,
      createdAt: now,
      updatedAt: now,
    })),
  ];
  return findConflicts({
    now,
    timeZone: state.settings.timezone,
    appointments: state.visits.map((visit) => ({
      id: visit.id,
      status: visit.status,
      startsAt: visit.startsAt,
      endsAt: visit.endsAt,
    })),
    workingHours: state.weekly.map((range) => ({
      weekday: range.weekday,
      start: range.startTime,
      end: range.endTime,
    })),
    datedWorkingHours: asDatedHours(rows),
    timeOff: state.offs.map((off) => ({ start: off.startsAt, end: off.endsAt })),
  }).flatMap((conflict) => {
    const visit = state.visits.find((visit) => visit.id === conflict.id);
    return visit
      ? [
          {
            appointmentId: visit.id,
            clientId: visit.clientId,
            startsAt: visit.startsAt.toISOString(),
            endsAt: visit.endsAt.toISOString(),
            reasons: conflict.reasons,
          },
        ]
      : [];
  });
}
async function review(tx: Tx, staffId: string, selection: DateShiftInput, now: Date) {
  const dates = targets(selection);
  const settings = await getSalonSettings(tx);
  validateWindow(dates, settings.timezone, now);
  const sourceDates =
    selection.mode === "copy" ? expandShiftTargets(selection).map((pair) => pair.source) : [];
  const sourceFirst = [...sourceDates].sort()[0];
  const sourceLast = [...sourceDates].sort().at(-1);
  if (
    sourceFirst &&
    (sourceFirst < shiftDate(dateOf(now, settings.timezone), -730) ||
      (sourceLast ?? "") > shiftDate(dateOf(now, settings.timezone), 730))
  )
    throw new DomainError("validation_error", "Choose source dates within two years of today");
  const state = await context(tx, staffId, dates, now);
  const sourceRows =
    sourceFirst && sourceLast ? await loadShiftRows(tx, [staffId], sourceFirst, sourceLast) : [];
  const desired =
    selection.mode === "edit"
      ? selection.changes
      : expandShiftTargets(selection).map((pair) => ({
          date: pair.target,
          ranges: shiftDay(pair.source, state.weekly, sourceRows).effectiveRanges,
        }));
  const changes = desired
    .map((change) => {
      if (change.ranges !== null && !dateShiftRangesSchema.safeParse(change.ranges).success)
        throw new DomainError(
          "validation_error",
          `Choose at most eight non-overlapping shifts for ${change.date}`,
        );
      validTime(change.date, change.ranges, settings.timezone);
      const previous = shiftDay(change.date, state.weekly, state.rows);
      const changed = hash(previous.ranges) !== hash(change.ranges);
      const next = {
        date: change.date,
        version: previous.version + (changed ? 1 : 0),
        ranges: change.ranges,
        effectiveRanges: change.ranges ?? previous.effectiveRanges,
      };
      if (change.ranges === null)
        next.effectiveRanges = shiftDay(change.date, state.weekly, []).effectiveRanges;
      return { date: change.date, previous, next };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const proposed = changes.map((change) => change.next);
  const dated = proposed.map((day) => ({
    date: day.date,
    ranges: day.effectiveRanges.map((range) => ({ start: range.startTime, end: range.endTime })),
  }));
  const expiredOffers = state.offers.filter((offer) =>
    bookingViolations({
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
      timeZone: settings.timezone,
      now,
      minNoticeMinutes: 0,
      maxDaysAhead: 100000,
      workingHours: [],
      datedWorkingHours: dated,
      timeOff: [],
    }).includes("outside_working_hours"),
  );
  const preview: DateShiftPreview = {
    staffId,
    timezone: settings.timezone,
    reviewHash: hash({
      staffId,
      selection,
      settings: state.settings,
      weekly: state.weekly,
      rows: state.rows,
      sourceRows,
      visits: state.visits,
      offers: state.offers,
      offs: state.offs,
    }),
    changes,
    conflicts: conflictsFor(state, proposed, now),
    withdrawnOffers: expiredOffers.length,
  };
  return { preview, expiredOffers };
}
export async function getDateShifts(
  db: Database,
  staffId: string,
  from: string,
  to: string,
  principal: Principal,
  now: Date,
) {
  authorizeStaffScheduleRead(principal, staffId);
  await requireStaff(db, staffId);
  if (to < from || Date.parse(`${to}T12:00Z`) - Date.parse(`${from}T12:00Z`) > 365 * 86400000)
    throw new DomainError("validation_error", "Read up to 366 consecutive days");
  const dates = Array.from(
    {
      length:
        Math.round((Date.parse(`${to}T12:00Z`) - Date.parse(`${from}T12:00Z`)) / 86400000) + 1,
    },
    (_, index) => shiftDate(from, index),
  );
  const state = await context(db, staffId, dates, now);
  return {
    staffId,
    timezone: state.settings.timezone,
    days: dates.map((date) => shiftDay(date, state.weekly, state.rows)),
    conflicts: conflictsFor(state, [], now),
  };
}
export async function previewDateShifts(
  db: Database,
  staffId: string,
  selection: DateShiftInput,
  principal: Principal,
  now: Date,
) {
  requirePermission(principal, "editSchedules");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    await lockCalendars(tx, [staffId]);
    await currentPrincipal(tx, principal);
    await requireStaff(tx, staffId);
    return (await review(tx, staffId, selection, now)).preview;
  });
}
export async function commitDateShifts(
  db: Database,
  staffId: string,
  input: DateShiftCommit,
  principal: Principal,
  now: Date,
) {
  requirePermission(principal, "editSchedules");
  const fingerprint = hash({ staffId, selection: input.selection, reviewHash: input.reviewHash });
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    await lockCalendars(tx, [staffId]);
    await currentPrincipal(tx, principal);
    await requireStaff(tx, staffId);
    const [prior] = await tx
      .select()
      .from(dateShiftBatch)
      .where(
        and(
          eq(dateShiftBatch.createdBy, principal.userId),
          eq(dateShiftBatch.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (prior && prior.requestFingerprint !== fingerprint)
      throw new DomainError(
        "invalid_state",
        "This schedule batch identifier belongs to another reviewed change",
      );
    const dates = prior?.dates ?? targets(input.selection);
    let withdrawnOffers = 0;
    if (!prior) {
      const { preview, expiredOffers } = await review(tx, staffId, input.selection, now);
      withdrawnOffers = expiredOffers.length;
      if (preview.reviewHash !== input.reviewHash)
        throw new DomainError(
          "version_conflict",
          "The schedule or affected bookings changed; review the dates again",
        );
      const [total] = await tx
        .select({ count: count() })
        .from(dateShift)
        .where(eq(dateShift.staffId, staffId));
      const additions = preview.changes.filter(
        (change) => change.previous.version === 0 && change.next.version > 0,
      ).length;
      if ((total?.count ?? 0) + additions > 5000)
        throw new DomainError("storage_limit", "The dated shift history capacity has been reached");
      for (const change of preview.changes) {
        if (change.previous.version === change.next.version) continue;
        await tx
          .insert(dateShift)
          .values({
            staffId,
            date: change.date,
            ranges: change.next.ranges,
            version: change.next.version,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [dateShift.staffId, dateShift.date],
            set: { ranges: change.next.ranges, version: change.next.version, updatedAt: now },
          });
      }
      // Keep the entry -> scheduling lock order: expiration never locks queue entries here.
      for (const offer of expiredOffers)
        await tx
          .update(waitlistOffer)
          .set({ expiresAt: now })
          .where(eq(waitlistOffer.id, offer.id));
      await tx.insert(dateShiftBatch).values({
        staffId,
        createdBy: principal.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        dates,
        createdAt: now,
      });
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "date_shift.apply",
        entity: "staff",
        entityId: staffId,
        metadata: {
          dates,
          changedDays: preview.changes.filter(
            (change) => change.previous.version !== change.next.version,
          ).length,
          conflicts: preview.conflicts.length,
          withdrawnOffers: expiredOffers.length,
          mode: input.selection.mode,
        },
      });
    }
    const state = await context(tx, staffId, dates, now);
    return {
      staffId,
      timezone: state.settings.timezone,
      days: dates.map((date) => shiftDay(date, state.weekly, state.rows)),
      conflicts: conflictsFor(state, [], now),
      replayed: Boolean(prior),
      withdrawnOffers,
    };
  });
}
