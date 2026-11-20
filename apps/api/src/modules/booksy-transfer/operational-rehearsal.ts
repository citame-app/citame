import {
  appointment,
  appointmentContext,
  appointmentService,
  type Database,
  resourcePool,
  resourceReservation,
  salonSettings,
  serviceResource,
  staffProfile,
  staffReservation,
  timeOff,
  waitlistSourceEntry,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { lockScheduling, type Tx } from "../../tx";
import { IMPORTED_STAFF_UNIT_START } from "../availability/staff-reservations";
import { repackResourceUnits } from "../resources/plan";
import { IMPORTED_RESOURCE_UNIT_START } from "../resources/reservations";
import { booksyLocalDayBounds } from "./local-day";
import { reviewBooksyPaymentEvidence } from "./payment-evidence";
import { planBooksyTransfer, sourceUuid, stableJson, summarizeTransferIssues } from "./plan";
import { reviewBooksyCombinations, verifyBookedBooksyCombinations } from "./source-combinations";
import {
  BOOKSY_HIDDEN_PRICE,
  booksyBookedAddonsSchema,
  booksyBookedServiceSchema,
  booksyCents,
  type BooksySourceReadModel,
  projectBookedAddons,
  sourceInstant,
} from "./source-read-model";
import { loadBooksySourceModel } from "./source-store";
import { archivedServiceColumns, verifyBooksyProjection } from "./verify";
import { planBooksyWaitlist } from "./waitlist";

const sourceLeaf = z.object({
  id: z.number().int(),
  booked_from: z.string().optional(),
  booked_till: z.string().optional(),
  staffer_id: z.number().int().positive().optional(),
  service: booksyBookedServiceSchema.optional(),
  service_price: z.string().optional(),
  is_staffer_requested_by_client: z.boolean().nullable().optional(),
  addons: booksyBookedAddonsSchema.optional(),
  appliance_id: z.number().int().nullable(),
  gap_hole_start: z.unknown().optional(),
  gap_hole_end: z.unknown().optional(),
  gap_time: z.record(z.string(), z.unknown()).nullable().optional(),
});
const sourceObject = z.record(z.string(), z.unknown());
const sourceInterval = z.object({
  booked_from: z.iso.datetime({ local: true }).refine((value) => !value.endsWith("Z")),
  booked_till: z.iso.datetime({ local: true }).refine((value) => !value.endsWith("Z")),
});

const reservationDetail = z.object({
  appointment: z.object({
    appointment_uid: z.number().int().positive().optional(),
    subbookings: z.array(z.unknown()),
  }),
});

function leafBookings(rows: unknown[]): z.infer<typeof sourceLeaf>[] {
  return rows.flatMap((input) => {
    const row = sourceObject.parse(input);
    if (Array.isArray(row.combo_children) && row.combo_children.length)
      return leafBookings(row.combo_children);
    return [sourceLeaf.parse(row)];
  });
}

function assertLinkedBooking(
  businessId: string,
  item: BooksySourceReadModel["appointments"][number],
  leaf: Omit<z.infer<typeof sourceLeaf>, "id">,
  requiresDetail: boolean,
  catalogueRefs: ReadonlySet<string>,
) {
  const primary = item.services[0];
  if (!primary) throw new Error("Frozen booking has no primary service");
  if (
    requiresDetail &&
    (leaf.booked_from === undefined ||
      leaf.booked_till === undefined ||
      leaf.staffer_id === undefined ||
      leaf.service === undefined ||
      leaf.service_price === undefined ||
      leaf.is_staffer_requested_by_client === undefined ||
      leaf.addons === undefined)
  )
    throw new Error("Reservation detail is missing linked booking evidence");
  if (
    (leaf.booked_from !== undefined &&
      Temporal.Instant.compare(sourceInstant(leaf.booked_from), item.startsAt) !== 0) ||
    (leaf.booked_till !== undefined &&
      Temporal.Instant.compare(sourceInstant(leaf.booked_till), item.endsAt) !== 0)
  )
    throw new Error("Frozen booking interval differs from reservation detail");
  if (
    leaf.staffer_id !== undefined &&
    sourceUuid(businessId, "staff", String(leaf.staffer_id)) !== item.staffId
  )
    throw new Error("Frozen booking professional differs from reservation detail");
  if (leaf.service) {
    const serviceId = leaf.service.id
      ? sourceUuid(businessId, "services", String(leaf.service.id))
      : null;
    if (serviceId !== primary.serviceId || leaf.service.name !== primary.name)
      throw new Error("Frozen primary treatment differs from reservation detail");
  }
  if (leaf.service_price !== undefined) {
    const hidden = leaf.service_price === BOOKSY_HIDDEN_PRICE;
    if (
      hidden !== Boolean(primary.sourceUnpriced) ||
      primary.priceCents !== (hidden ? 0 : booksyCents(leaf.service_price)) ||
      primary.currency !== "EUR"
    )
      throw new Error("Frozen primary price differs from reservation detail");
  }
  if (
    leaf.is_staffer_requested_by_client !== undefined &&
    Boolean(item.serviceBadges?.find(({ servicePosition }) => servicePosition === 0)?.requested) !==
      (leaf.is_staffer_requested_by_client === true)
  )
    throw new Error("Frozen staff preference differs from reservation detail");
  const extras = projectBookedAddons(businessId, leaf.addons ?? [], catalogueRefs);
  if (
    item.services.length !== 1 + extras.length ||
    extras.some((expected, position) => {
      const actual = item.services[position + 1];
      return (
        !actual ||
        actual.serviceId !== expected.serviceId ||
        actual.name !== expected.name ||
        actual.durationMinutes !== expected.durationMinutes ||
        actual.bufferMinutes !== expected.bufferMinutes ||
        actual.priceCents !== expected.priceCents ||
        actual.currency !== expected.currency ||
        actual.sourceUnpriced === true ||
        actual.priceDisplayLabel !== undefined ||
        actual.processing !== undefined
      );
    })
  )
    throw new Error("Frozen booked add-ons differ from reservation detail");
}

interface Interval {
  id: string;
  start: number;
  end: number;
}

/** Derive the smallest number of units needed by the frozen windows, not a booking policy. */
function unitPlan(intervals: Interval[], max: number) {
  for (let units = 1; units <= max; units++) {
    const allocation = repackResourceUnits(units, intervals);
    if (allocation) return { units, allocation, intervals };
  }
  throw new Error("Source intervals exceed the native engine's capacity range");
}

/** Count distinct periods at which the frozen bookings require more than the configured units. */
export function countCapacityConflicts(
  intervals: readonly Pick<Interval, "start" | "end">[],
  capacity: number,
) {
  const events = new Map<number, number>();
  for (const { start, end } of intervals) {
    events.set(start, (events.get(start) ?? 0) + 1);
    events.set(end, (events.get(end) ?? 0) - 1);
  }
  let occupancy = 0;
  let conflicts = 0;
  for (const [, change] of [...events].sort(([a], [b]) => a - b)) {
    if (occupancy <= capacity && occupancy + change > capacity) conflicts++;
    occupancy += change;
  }
  return conflicts;
}

export function planNativeRehearsal(model: BooksySourceReadModel) {
  if (model.base.unprojected.some((row) => row.kind === "catalog_processing_terms"))
    throw new Error("Catalogue processing times require a verified import mapping");
  const resources = new Map(
    model.resources.map((raw) => {
      const r = z.object({ id: z.number().int(), name: z.string() }).parse(raw);
      return [
        r.id,
        { id: sourceUuid(model.businessId, "sourceResources", String(r.id)), name: r.name },
      ] as const;
    }),
  );
  const staffRefs = new Set(model.base.staff.map((row) => row.sourceId));
  const catalogueRefs = new Set(model.base.services.map(({ sourceId }) => sourceId));
  const combinationPrices = verifyBookedBooksyCombinations(model);
  const resourceRules = model.base.services.flatMap((row) => {
    const { resources: refs = [] } = z
      .object({ resources: z.array(z.number().int()).optional() })
      .parse(row.raw);
    if (new Set(refs).size !== refs.length)
      throw new Error("Repeated catalogue resource reference");
    const choices = refs.flatMap((id) => {
      const pool = resources.get(id);
      if (pool) return [pool.id];
      if (!staffRefs.has(String(id))) throw new Error("Unmapped catalogue resource reference");
      return [];
    });
    return choices.map((resourceId) => ({
      serviceId: sourceUuid(model.businessId, "services", row.sourceId),
      resourceId,
      quantity: 1,
      alternative: choices.length > 1,
    }));
  });
  const byId = new Map(model.appointments.map((item) => [item.id, item]));
  const work = new Map<string, Interval[]>();
  const equipment = new Map<string, Interval[]>();
  const visits = [];
  const groupIds = new Set<string>();
  const firstDay = Temporal.PlainDate.from(model.fromDate).toPlainDateTime();
  const afterLastDay = Temporal.PlainDate.from(model.throughDate)
    .add({ days: 1 })
    .toPlainDateTime();
  for (const group of model.groups) {
    if (groupIds.has(group.sourceId) || !group.ids.length)
      throw new Error("Source reservation group is empty or duplicated");
    groupIds.add(group.sourceId);
    const visitGroupId = sourceUuid(model.businessId, "visitGroups", group.sourceId);
    const visible =
      group.raw.kind === "booksy-reviewed-visible-booking"
        ? z
            .object({
              itemRef: z.string().regex(/^\d+$/),
              resourceRef: z.number().int().positive(),
              evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .parse(group.raw)
        : null;
    if (
      visible &&
      (group.ids.length !== 1 ||
        !model.base.artifacts.some((a) => a.sha256 === visible.evidenceSha256))
    )
      throw new Error("Reviewed visible booking evidence is missing or ambiguous");
    const detail = visible ? null : reservationDetail.parse(group.raw).appointment;
    if (detail?.appointment_uid !== undefined && String(detail.appointment_uid) !== group.sourceId)
      throw new Error("Reservation detail identifier differs from its group");
    const leaves = detail ? leafBookings(detail.subbookings) : [];
    const remaining = new Map(leaves.map((row) => [String(row.id), row]));
    if (remaining.size !== leaves.length)
      throw new Error("Source reservation detail repeats a service line");
    for (const id of group.ids) {
      const item = byId.get(id);
      if (!item?.sourceCopy || item.sourceCopy.groupRef !== group.sourceId)
        throw new Error("Source group membership differs");
      byId.delete(id);
      const leaf: Omit<z.infer<typeof sourceLeaf>, "id"> | undefined =
        visible && visible.itemRef === item.sourceCopy.itemRef
          ? { appliance_id: visible.resourceRef }
          : remaining.get(item.sourceCopy.itemRef);
      remaining.delete(item.sourceCopy.itemRef);
      if (
        leaf?.gap_hole_start != null ||
        leaf?.gap_hole_end != null ||
        (leaf?.gap_time && Object.keys(leaf.gap_time).length)
      )
        throw new Error("Booked processing times require a verified import mapping");
      const resource = leaf?.appliance_id == null ? null : resources.get(leaf.appliance_id);
      if (
        !leaf ||
        resource === undefined ||
        (resource
          ? item.resources?.length !== 1 ||
            item.resources[0]?.name !== resource.name ||
            item.resources[0]?.quantity !== 1
          : Boolean(item.resources?.length))
      )
        throw new Error("Calendar and detailed resource assignment differ");
      if (detail)
        assertLinkedBooking(
          model.businessId,
          item,
          leaf,
          detail.appointment_uid !== undefined,
          catalogueRefs,
        );
      else if (item.services.length !== 1)
        throw new Error("Reviewed visible booking requires exactly one verified service");

      const start = Date.parse(item.startsAt);
      const end = Date.parse(item.endsAt);
      const interval = { id, start, end };
      const minutes = (end - start) / 60_000;
      const extras = item.services
        .slice(1)
        .reduce((total, s) => total + s.durationMinutes + s.bufferMinutes, 0);
      if (!Number.isInteger(minutes) || minutes <= extras || !item.services.length)
        throw new Error("Frozen services do not fit within the source interval");
      const services = item.services.map((s, position) => ({
        ...s,
        durationMinutes: position === 0 ? minutes - extras - s.bufferMinutes : s.durationMinutes,
      }));
      if (services[0]!.durationMinutes <= 0)
        throw new Error("Frozen primary service has no duration");
      const context = model.contexts[id];
      if (
        !context ||
        context.rows.length !== services.length ||
        context.rows.some((row, position) => row.servicePosition !== position)
      )
        throw new Error("Source context does not match the service positions");
      if (
        leaf.is_staffer_requested_by_client !== undefined &&
        context.rows[0]?.requestedStaffId !==
          (leaf.is_staffer_requested_by_client === true ? item.staffId : null)
      )
        throw new Error("Frozen staff preference context differs from reservation detail");
      const windows = work.get(item.staffId) ?? [];
      windows.push(interval);
      work.set(item.staffId, windows);
      if (resource) {
        const occupied = equipment.get(resource.id) ?? [];
        occupied.push(interval);
        equipment.set(resource.id, occupied);
      }
      visits.push({
        visitGroupId,
        sourceBookingRef: group.sourceId,
        sourceLineRef: item.sourceCopy.itemRef,
        item,
        services,
        context,
        resource,
        start,
        end,
        minutes,
      });
    }
    for (const leaf of remaining.values()) {
      const interval = sourceInterval.safeParse(leaf);
      if (interval.success) {
        const start = Temporal.PlainDateTime.from(interval.data.booked_from);
        const end = Temporal.PlainDateTime.from(interval.data.booked_till);
        if (
          Temporal.PlainDateTime.compare(start, end) < 0 &&
          (Temporal.PlainDateTime.compare(end, firstDay) <= 0 ||
            Temporal.PlainDateTime.compare(start, afterLastDay) >= 0)
        )
          continue;
      }
      throw new Error("Reservation detail contains a service missing from the captured calendar");
    }
  }
  if (
    byId.size ||
    visits.length !== model.summary.bookedServices ||
    groupIds.size !== model.summary.groups
  )
    throw new Error("Not every source service belongs to a reservation");
  return {
    combinationPrices,
    resourceRules,
    visits: visits.sort(
      (a, b) => a.start - b.start || a.end - b.end || a.item.id.localeCompare(b.item.id),
    ),
    staff: new Map([...work].map(([id, rows]) => [id, unitPlan(rows, 6)])),
    resources: new Map([...equipment].map(([id, rows]) => [id, unitPlan(rows, 20)])),
  };
}

type NativePlan = ReturnType<typeof planNativeRehearsal>;

type ScheduleVisit = Pick<NativePlan["visits"][number], "start" | "visitGroupId" | "services"> & {
  item: Pick<NativePlan["visits"][number]["item"], "staffId" | "status">;
};

export function summarizeNativeSchedule(visits: readonly ScheduleVisit[], timezone: string) {
  const breakdown = new Map<
    string,
    {
      date: string;
      staffId: string;
      status: ScheduleVisit["item"]["status"];
      calendarLines: number;
      frozenServices: number;
      groups: Set<string>;
    }
  >();
  for (const {
    start,
    item: { staffId, status },
    visitGroupId,
    services,
  } of visits) {
    const date = Temporal.Instant.fromEpochMilliseconds(start)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString();
    const key = `${date}/${staffId}/${status}`;
    const bucket = breakdown.get(key) ?? {
      date,
      staffId,
      status,
      calendarLines: 0,
      frozenServices: 0,
      groups: new Set<string>(),
    };
    bucket.calendarLines++;
    bucket.frozenServices += services.length;
    bucket.groups.add(visitGroupId);
    breakdown.set(key, bucket);
  }
  return [...breakdown.values()]
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.staffId.localeCompare(b.staffId) ||
        a.status.localeCompare(b.status),
    )
    .map(({ groups, ...bucket }) => ({ ...bucket, visitGroups: groups.size }));
}

function summarizeNativeBilling(visits: NativePlan["visits"]) {
  const price = { serviceLines: 0, calendarLines: 0, visitGroups: 0 };
  const groups = new Set<string>();
  const invoice = { positive: 0, negative: 0, unknown: 0 };
  const payment = { positive: 0, negative: 0, unknown: 0 };
  const flag = (values: (boolean | null)[]) =>
    values.includes(true) ? "positive" : values.includes(null) ? "unknown" : "negative";

  for (const visit of visits) {
    const missing = visit.services.filter((service) => service.sourceUnpriced).length;
    if (missing) {
      price.serviceLines += missing;
      price.calendarLines++;
      groups.add(visit.visitGroupId);
    }
    invoice[flag(visit.context.rows.map(({ invoiced }) => invoiced))]++;
    payment[flag(visit.context.rows.map(({ paid }) => paid))]++;
  }
  price.visitGroups = groups.size;
  return { missingPrices: price, invoice, payment };
}

async function expectedNativeCapacity(tx: Tx, plan: NativePlan) {
  let staffingPoliciesToReview = 0;
  let staffingConflictPeriods = 0;
  const importedStaffUnits = new Map<string, number>();
  const staffLimits = new Map<string, number>();
  let resourcePoliciesToReview = 0;
  let resourceConflictPeriods = 0;
  const importedResourceUnits = new Map<string, number>();
  const resourceLimits = new Map<string, number>();
  for (const [id, allocation] of plan.staff) {
    const [row] = await tx
      .select({ capacity: staffProfile.maxConcurrent })
      .from(staffProfile)
      .where(eq(staffProfile.id, id));
    if (!row) throw new Error("Professional missing from the native directory");
    staffLimits.set(id, row.capacity);
    if (allocation.units > row.capacity) {
      staffingPoliciesToReview++;
      staffingConflictPeriods += countCapacityConflicts(allocation.intervals, row.capacity);
      for (const unit of allocation.allocation)
        importedStaffUnits.set(unit.id, IMPORTED_STAFF_UNIT_START + unit.unitIndex);
    }
  }
  for (const [id, allocation] of plan.resources) {
    const [row] = await tx
      .select({ capacity: resourcePool.capacity })
      .from(resourcePool)
      .where(eq(resourcePool.id, id));
    if (!row) throw new Error("Resource missing from the native catalogue");
    resourceLimits.set(id, row.capacity);
    if (allocation.units > row.capacity) {
      resourcePoliciesToReview++;
      resourceConflictPeriods += countCapacityConflicts(allocation.intervals, row.capacity);
      for (const unit of allocation.allocation)
        importedResourceUnits.set(unit.id, IMPORTED_RESOURCE_UNIT_START + unit.unitIndex);
    }
  }
  return {
    staffingPoliciesToReview,
    staffingConflictPeriods,
    importedStaffUnits,
    staffLimits,
    resourcePoliciesToReview,
    resourceConflictPeriods,
    importedResourceUnits,
    resourceLimits,
  };
}

async function verifyNativeProjection(
  tx: Tx,
  plan: NativePlan,
  {
    importedStaffUnits,
    staffLimits,
    importedResourceUnits,
    resourceLimits,
  }: Awaited<ReturnType<typeof expectedNativeCapacity>>,
) {
  const bookedServiceRows = plan.visits.reduce((total, v) => total + v.services.length, 0);
  const occupiedResources = plan.visits.filter((v) => v.resource).length;
  const planById = new Map(plan.visits.map((v) => [v.item.id, v]));
  const actual = await tx
    .select({
      id: appointment.id,
      staffId: appointment.staffId,
      clientId: appointment.clientId,
      visitGroupId: appointment.visitGroupId,
      start: appointment.startsAt,
      end: appointment.endsAt,
      status: appointment.status,
      deletedAt: appointment.deletedAt,
      requestedStaffId: appointment.requestedStaffId,
      workWindows: appointment.workWindows,
      sourceStaffWindow: appointment.sourceStaffWindow,
      sourceResourceWindow: appointment.sourceResourceWindow,
      businessMessage: appointment.sourceBusinessMessage,
      customerComment: appointment.customerComment,
    })
    .from(appointment);
  const services = await tx.select(archivedServiceColumns).from(appointmentService);
  const servicePositions = new Map(
    services.map((row) => [`${row.appointmentId}/${row.position}`, row.id]),
  );
  const annotations = await tx.select().from(appointmentContext);
  const staffWork = await tx.select().from(staffReservation);
  const physical = await tx.select().from(resourceReservation);
  if (
    actual.length !== plan.visits.length ||
    actual.some((row) => {
      const v = planById.get(row.id);
      if (!v) return true;
      const window = {
        startsAt: new Date(v.start).toISOString(),
        endsAt: new Date(v.end).toISOString(),
      };
      const expectedStaffWindow = importedStaffUnits.has(row.id)
        ? { staffId: v.item.staffId, ...window }
        : null;
      const expectedResourceWindow =
        v.resource && importedResourceUnits.has(row.id)
          ? { resourceId: v.resource.id, ...window }
          : null;
      return (
        row.deletedAt !== null ||
        row.staffId !== v.item.staffId ||
        row.clientId !== v.item.clientId ||
        row.visitGroupId !== v.visitGroupId ||
        row.start.getTime() !== v.start ||
        row.end.getTime() !== v.end ||
        row.status !== v.item.status ||
        row.requestedStaffId !== (v.context.rows[0]?.requestedStaffId ?? null) ||
        row.workWindows !== null ||
        stableJson(row.sourceStaffWindow) !== stableJson(expectedStaffWindow) ||
        stableJson(row.sourceResourceWindow) !== stableJson(expectedResourceWindow) ||
        row.businessMessage !== (v.context.businessMessage ?? null) ||
        row.customerComment !== (v.context.customerComment ?? null)
      );
    }) ||
    services.length !== bookedServiceRows ||
    servicePositions.size !== bookedServiceRows ||
    services.some((row) => {
      const expected = planById.get(row.appointmentId)?.services[row.position];
      return (
        !expected ||
        row.serviceId !== expected.serviceId ||
        row.name !== expected.name ||
        row.durationMinutes !== expected.durationMinutes ||
        row.bufferMinutes !== expected.bufferMinutes ||
        row.processingStartMinutes !== null ||
        row.processingMinutes !== null ||
        row.priceCents !== expected.priceCents ||
        row.reviewedPriceCents !== null ||
        row.sourceUnpriced !== (expected.sourceUnpriced === true) ||
        row.currency !== expected.currency
      );
    }) ||
    annotations.length !== bookedServiceRows ||
    annotations.some((row) => {
      const expected = planById.get(row.appointmentId)?.context.rows[row.servicePosition];
      return (
        !expected ||
        row.source !== "booksy" ||
        row.sourceRef !== expected.sourceRef ||
        row.internalNote !== expected.internalNote ||
        row.customerComment !== expected.customerComment ||
        row.requestedStaffId !== expected.requestedStaffId ||
        row.paid !== expected.paid ||
        row.invoiced !== expected.invoiced
      );
    }) ||
    staffWork.length !== plan.visits.length ||
    staffWork.some((row) => {
      const expected = row.appointmentId && planById.get(row.appointmentId);
      const importedUnit = expected ? importedStaffUnits.get(expected.item.id) : undefined;
      return (
        !expected ||
        row.staffId !== expected.item.staffId ||
        (importedUnit === undefined
          ? row.unitIndex >= (staffLimits.get(row.staffId) ?? 0)
          : row.unitIndex !== importedUnit) ||
        row.position !== 0 ||
        row.offsetMinutes !== 0 ||
        row.endOffsetMinutes !== null ||
        row.active !== (expected.item.status !== "cancelled") ||
        row.released ||
        row.startsAt.getTime() !== expected.start ||
        row.endsAt.getTime() !== expected.end
      );
    }) ||
    physical.length !== occupiedResources ||
    physical.some((row) => {
      const expected = row.appointmentId && planById.get(row.appointmentId);
      const importedUnit = expected ? importedResourceUnits.get(expected.item.id) : undefined;
      return (
        !expected ||
        row.resourceId !== expected.resource?.id ||
        row.name !== expected.resource?.name ||
        row.servicePosition !== 0 ||
        row.offsetMinutes !== 0 ||
        row.endOffsetMinutes !== expected.minutes ||
        (importedUnit === undefined
          ? row.unitIndex >= (resourceLimits.get(row.resourceId) ?? 0)
          : row.unitIndex !== importedUnit) ||
        row.active !== (expected.item.status !== "cancelled") ||
        row.released ||
        row.startsAt.getTime() !== expected.start ||
        row.endsAt.getTime() !== expected.end
      );
    })
  )
    throw new Error("Native transaction did not reconcile the source schedule");
  return servicePositions;
}

function verifiedBookingLinks(
  visits: NativePlan["visits"],
  servicePositions: Awaited<ReturnType<typeof verifyNativeProjection>>,
) {
  type Line = {
    sourceLineRef: string;
    appointmentId: string;
    services: { position: number; appointmentServiceId: string }[];
  };
  const bookings = new Map<
    string,
    { visitGroupId: string; sourceBookingRef: string; lines: Line[] }
  >();
  for (const visit of visits) {
    const { visitGroupId, sourceBookingRef, sourceLineRef, item } = visit;
    const booking = bookings.get(visitGroupId) ?? { visitGroupId, sourceBookingRef, lines: [] };
    booking.lines.push({
      sourceLineRef,
      appointmentId: item.id,
      services: visit.services.map((_, position) => {
        const appointmentServiceId = servicePositions.get(`${item.id}/${position}`);
        if (!appointmentServiceId) throw new Error("A verified appointment service is missing");
        return { position, appointmentServiceId };
      }),
    });
    bookings.set(visitGroupId, booking);
  }
  return [...bookings.values()];
}

async function assertNoNativeEffects(tx: Tx) {
  const [effects] = await tx.execute<{
    receipts: number;
    payments: number;
    bookingProtections: number;
    cancellationFees: number;
    reminders: number;
    waitlistEntries: number;
    waitlistOffers: number;
    waitlistEnabled: boolean;
  }>(sql`
    select (select count(*)::int from checkout) as receipts,
           (select count(*)::int from checkout_payment) as payments,
           (select count(*)::int from booking_protection) as "bookingProtections",
           (select count(*)::int from booking_fee_movement) as "cancellationFees",
           (select count(*)::int from reminder) as reminders,
           (select count(*)::int from waitlist_entry) as "waitlistEntries",
           (select count(*)::int from waitlist_offer) as "waitlistOffers",
           coalesce((select (terms->>'enabled')::boolean from waitlist_policy where id=1),false) as "waitlistEnabled"
  `);
  if (!effects || Object.values(effects).some(Boolean))
    throw new Error("The candidate contains operational effects or an enabled waitlist");
  return effects;
}

async function assertCandidateSettings(tx: Tx, timezone: string) {
  const [settings] = await tx
    .select({
      timezone: salonSettings.timezone,
      firstReminder: salonSettings.reminderFirstLeadMinutes,
      secondReminder: salonSettings.reminderSecondLeadMinutes,
    })
    .from(salonSettings);
  if (
    !settings ||
    settings.timezone !== timezone ||
    settings.firstReminder !== null ||
    settings.secondReminder !== null
  )
    throw new Error("The candidate must use the source timezone and pause appointment reminders");
}

/** Reconcile a persisted candidate under one read-only snapshot. Prints no client data. */
export async function inspectNativeBooksy(
  db: Database,
  snapshotHash: string,
  date: string,
  options: { bookingLinks?: boolean; priceHolds?: "day" | "all" } = {},
) {
  return db.transaction(
    async (tx) => {
      const model = await loadBooksySourceModel(tx, snapshotHash, { exclusiveExtensions: true });
      const { start, end } = booksyLocalDayBounds(date, model.base.timezone);
      if (date < model.fromDate || date > model.throughDate)
        throw new Error("The requested day is outside the captured calendar");
      await assertCandidateSettings(tx, model.base.timezone);
      const base = await verifyBooksyProjection(tx, model.base, { candidate: true });
      const plan = planNativeRehearsal(model);
      const capacity = await expectedNativeCapacity(tx, plan);
      const servicePositions = await verifyNativeProjection(tx, plan, capacity);
      const waitlist = await planBooksyWaitlist(tx, model);
      const waitlistRows = await tx.select().from(waitlistSourceEntry);
      const expectedWaitlist = new Map(waitlist.entries.map((row) => [row.id, row]));
      if (
        waitlistRows.length !== expectedWaitlist.size ||
        waitlistRows.some((row) => {
          const { linkedEntryId, ...original } = row;
          return (
            linkedEntryId !== null ||
            stableJson(original) !== stableJson(expectedWaitlist.get(row.id))
          );
        })
      )
        throw new Error("The native waitlist differs from its reviewed archive");

      const rules = await tx
        .select({
          serviceId: serviceResource.serviceId,
          resourceId: serviceResource.resourceId,
          quantity: serviceResource.quantity,
          alternative: serviceResource.alternative,
        })
        .from(serviceResource);
      const normalized = (rows: NativePlan["resourceRules"]) => rows.map(stableJson).sort();
      if (stableJson(normalized(rules)) !== stableJson(normalized(plan.resourceRules)))
        throw new Error("The native catalogue resource rules differ");

      const blocks = await tx.select().from(timeOff);
      const expectedBlocks = new Map(
        model.base.timeOff.map((row) => [
          sourceUuid(model.businessId, "timeOff", row.sourceId),
          row,
        ]),
      );
      if (
        blocks.length !== expectedBlocks.size ||
        blocks.some((row) => {
          const expected = expectedBlocks.get(row.id);
          return (
            !expected ||
            row.deletedAt !== null ||
            row.staffId !== sourceUuid(model.businessId, "staff", expected.staffRef) ||
            row.startsAt.getTime() !== Date.parse(expected.startsAt) ||
            row.endsAt.getTime() !== Date.parse(expected.endsAt) ||
            row.reason !== expected.reason
          );
        })
      )
        throw new Error("The native staff blocks differ from the source");

      const sideEffects = await assertNoNativeEffects(tx);

      const report = planBooksyTransfer(model.base).review;
      if (!report.canRehearse) throw new Error("The retained source plan failed validation");
      const dailyVisits = plan.visits.filter((v) => v.start < end && v.end > start);
      const billing = summarizeNativeBilling(plan.visits);
      const groups = (rows: NativePlan["visits"]) => new Set(rows.map((v) => v.visitGroupId)).size;
      const coverageGaps = Object.entries(model.base.coverage)
        .filter(([, value]) => value.state !== "complete")
        .map(([area, value]) => ({ area, state: value.state }));
      const servicesWithResourceRules = new Set(rules.map(({ serviceId }) => serviceId));
      const projectedBlockOriginals = new Set(
        model.base.timeOff.flatMap(({ sourceId, raw, staffRef }) => {
          const suffix = `:${staffRef}`;
          return sourceId.endsWith(suffix)
            ? [stableJson([sourceId.slice(0, -suffix.length), raw])]
            : [];
        }),
      );
      const trackedNativeMappings = model.base.unprojected
        .filter(({ kind, sourceId, raw }) => {
          if (kind === "source_block_original")
            return projectedBlockOriginals.has(stableJson([sourceId, raw]));
          return (
            kind === "alternate_service_resources" &&
            servicesWithResourceRules.has(sourceUuid(model.businessId, "services", sourceId))
          );
        })
        .map(({ kind }) => ({ code: "unprojected_record", kind }));
      return {
        snapshotHash,
        source: {
          capturedAt: model.capturedAt,
          fromDate: model.fromDate,
          throughDate: model.throughDate,
          timezone: model.base.timezone,
          lastObservedAppointmentAt: model.lastObservedAppointmentAt,
          lastAppointmentProven: model.lastAppointmentProven,
          archiveArtifactsVerified: new Set(model.base.artifacts.map((a) => a.sha256)).size,
          productRecords: model.inventory.length,
          physicalResourceRecords: model.resources.length,
          paymentEvidence: reviewBooksyPaymentEvidence(model),
        },
        day: {
          date,
          calendarLines: dailyVisits.length,
          visitGroups: groups(dailyVisits),
          staffBlocks: blocks.filter(
            (row) => row.startsAt.getTime() < end && row.endsAt.getTime() > start,
          ).length,
          resourceAssignments: dailyVisits.filter((row) => row.resource).length,
          billingEvidence: summarizeNativeBilling(dailyVisits),
        },
        scheduleByStart: summarizeNativeSchedule(plan.visits, model.base.timezone),
        ...(options.bookingLinks
          ? { bookingLinks: verifiedBookingLinks(plan.visits, servicePositions) }
          : {}),
        ...(options.priceHolds
          ? {
              priceHolds: (options.priceHolds === "all" ? plan.visits : dailyVisits).flatMap(
                (visit) =>
                  visit.services.flatMap((service, servicePosition) => {
                    if (!service.sourceUnpriced) return [];
                    const appointmentServiceId = servicePositions.get(
                      `${visit.item.id}/${servicePosition}`,
                    );
                    if (!appointmentServiceId) throw new Error("A verified price hold is missing");
                    return [
                      {
                        sourceBookingRef: visit.sourceBookingRef,
                        sourceLineRef: visit.sourceLineRef,
                        appointmentId: visit.item.id,
                        servicePosition,
                        appointmentServiceId,
                      },
                    ];
                  }),
              ),
            }
          : {}),
        candidate: {
          clients: base.clients,
          staff: base.staff,
          services: base.services,
          workingHours: base.hours,
          staffServiceAssignments: base.assignments,
          addonEligibilityLinks: base.addonLinks,
          calendarLines: plan.visits.length,
          visitGroups: groups(plan.visits),
          staffBlocks: blocks.length,
          products: model.inventory.length,
          stockOpenings: model.inventory.length,
          physicalResources: model.resources.length,
          resourceRules: rules.length,
          resourceAssignments: plan.visits.filter((row) => row.resource).length,
          frozenServices: plan.visits.reduce((total, row) => total + row.services.length, 0),
          bookedCombinationPrices: plan.combinationPrices,
          staffCapacityConflicts: capacity.staffingConflictPeriods,
          resourceCapacityConflicts: capacity.resourceConflictPeriods,
          waitlistForReview: waitlistRows.length,
          waitlistObservedDates: waitlist.observedDates,
          ...sideEffects,
        },
        blockers: {
          coverageGaps,
          catalogueCombinations: reviewBooksyCombinations(model.base.services),
          translationAndCompleteness: report.blockers.length,
          translationAndCompletenessByReason: summarizeTransferIssues(report.blockers),
          trackedNativeMappings: summarizeTransferIssues(trackedNativeMappings),
          unresolvedClientIdentities: model.base.unprojected.filter(
            (row) => row.kind === "booksy_contact_identity_conflict",
          ).length,
          pricedLinesMissingAmount: billing.missingPrices.serviceLines,
          billingEvidence: billing,
          finalExportVerified: false,
          offsiteRecoveryVerified: false,
          ownerCutoverAccepted: false,
        },
        nativeFieldsVerified: true,
        canCutOver: false,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Preserve the frozen bookings under the real PostgreSQL constraints. The preparation mode
 * commits only to a separate local candidate, with no authenticated app or jobs attached.
 */
export async function rehearseNativeBooksy(
  db: Database,
  snapshotHash: string,
  mode: "rollback" | "prepare" = "rollback",
) {
  const [identity] = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const targetName =
    mode === "prepare" ? /^sob_booksy_candidate_\d{8}_\d+$/ : /^sob_booksy_restorecheck_\d{8}_\d+$/;
  if (!targetName.test(identity?.name ?? ""))
    throw new Error("The operation requires a separate local copy for the selected mode");
  const model = await loadBooksySourceModel(db, snapshotHash);
  const financialEvidence = reviewBooksyPaymentEvidence(model);
  if (financialEvidence.observedPositivePayment || financialEvidence.needsReconciliation)
    throw new Error(
      "Source deposits or payment records require financial reconciliation before native import",
    );
  const plan = planNativeRehearsal(model);
  const waitlist = await planBooksyWaitlist(db, model);
  const rollback = new Error("Rollback after successful rehearsal");
  let capacity: Awaited<ReturnType<typeof expectedNativeCapacity>> | undefined;
  const bookedServiceRows = plan.visits.reduce((total, v) => total + v.services.length, 0);
  const occupiedResources = plan.visits.filter((v) => v.resource).length;
  const planById = new Map(plan.visits.map((v) => [v.item.id, v]));
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('booksy-native-rollback-rehearsal-v1',0))`,
      );
      await lockScheduling(tx);
      await verifyBooksyProjection(tx, model.base, { candidate: true });
      const count = async (
        table:
          | typeof appointment
          | typeof appointmentService
          | typeof appointmentContext
          | typeof staffReservation
          | typeof resourceReservation,
      ) => {
        const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(table);
        return row?.count ?? 0;
      };
      if (
        (await count(appointment)) ||
        (await count(staffReservation)) ||
        (await count(resourceReservation))
      )
        throw new Error("The restored candidate already has operational reservations");
      if (mode === "prepare") {
        await tx
          .insert(salonSettings)
          .values({
            name: model.businessName,
            timezone: model.base.timezone,
            reminderFirstLeadMinutes: null,
            reminderSecondLeadMinutes: null,
          })
          .onConflictDoNothing();
        await assertCandidateSettings(tx, model.base.timezone);
      }
      if (plan.resourceRules.length) {
        const [prior] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(serviceResource);
        if (prior?.count) throw new Error("The candidate already has catalogue resource rules");
        await tx.insert(serviceResource).values(plan.resourceRules);
      }
      if (waitlist.entries.length) await tx.insert(waitlistSourceEntry).values(waitlist.entries);
      capacity = await expectedNativeCapacity(tx, plan);
      const { importedStaffUnits, importedResourceUnits } = capacity;
      const resourceUnit = new Map(
        [...plan.resources.values()].flatMap((r) =>
          r.allocation.map((unit) => [unit.id, unit.unitIndex] as const),
        ),
      );
      for (const visit of plan.visits) {
        const { visitGroupId, item, services, context, resource, start, end, minutes } = visit;
        const startsAt = new Date(start),
          endsAt = new Date(end);
        const importedStaffUnit = importedStaffUnits.get(item.id);
        const importedResourceUnit = importedResourceUnits.get(item.id);
        await tx.insert(appointment).values({
          id: item.id,
          staffId: item.staffId,
          clientId: item.clientId,
          visitGroupId,
          sourceStaffWindow:
            importedStaffUnit === undefined
              ? null
              : {
                  staffId: item.staffId,
                  startsAt: startsAt.toISOString(),
                  endsAt: endsAt.toISOString(),
                },
          sourceResourceWindow:
            resource && importedResourceUnit !== undefined
              ? {
                  resourceId: resource.id,
                  startsAt: startsAt.toISOString(),
                  endsAt: endsAt.toISOString(),
                }
              : null,
          startsAt,
          endsAt,
          status: item.status,
          sourceBusinessMessage: context.businessMessage ?? null,
          customerComment: context.customerComment,
          requestedStaffId: context.rows[0]?.requestedStaffId ?? null,
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
        });
        if (importedStaffUnit !== undefined)
          await tx
            .update(staffReservation)
            .set({ unitIndex: importedStaffUnit })
            .where(eq(staffReservation.appointmentId, item.id));
        await tx.insert(appointmentService).values(
          services.map((s, position) => ({
            appointmentId: item.id,
            position,
            serviceId: s.serviceId,
            name: s.name,
            durationMinutes: s.durationMinutes,
            bufferMinutes: s.bufferMinutes,
            priceCents: s.priceCents,
            sourceUnpriced: s.sourceUnpriced === true,
            currency: s.currency,
          })),
        );
        await tx.insert(appointmentContext).values(
          context.rows.map((row) => ({
            appointmentId: item.id,
            servicePosition: row.servicePosition,
            requestedStaffId: row.requestedStaffId,
            internalNote: row.internalNote,
            customerComment: row.customerComment,
            paid: row.paid,
            invoiced: row.invoiced,
            source: "booksy",
            sourceRef: row.sourceRef,
          })),
        );
        if (resource) {
          const unitIndex = importedResourceUnit ?? resourceUnit.get(item.id);
          if (unitIndex === undefined)
            throw new Error("Imported physical resource allocation is missing");
          await tx.insert(resourceReservation).values({
            resourceId: resource.id,
            appointmentId: item.id,
            servicePosition: 0,
            unitIndex,
            offsetMinutes: 0,
            endOffsetMinutes: minutes,
            startsAt,
            endsAt,
            name: resource.name,
          });
        }
      }
      await tx.execute(sql`set constraints all immediate`);
      await verifyNativeProjection(tx, plan, capacity);
      await assertNoNativeEffects(tx);
      if (mode === "rollback") throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!capacity) throw new Error("The source capacity review did not run");
  const {
    staffingPoliciesToReview,
    staffingConflictPeriods,
    importedStaffUnits,
    resourcePoliciesToReview,
    resourceConflictPeriods,
    importedResourceUnits,
  } = capacity;
  const [remaining] = await db.select({ count: sql<number>`count(*)::int` }).from(appointment);
  if (remaining?.count !== (mode === "rollback" ? 0 : plan.visits.length))
    throw new Error("The final number of native appointments differs from the selected operation");
  return {
    snapshotHash,
    groups: model.groups.length,
    nativeGroupsVerified: new Set(plan.visits.map((v) => v.visitGroupId)).size,
    catalogueResourceRules: plan.resourceRules.length,
    servicesWithResourceRules: new Set(plan.resourceRules.map((row) => row.serviceId)).size,
    waitlistRequestsForReview: waitlist.entries.length,
    waitlistObservedDates: waitlist.observedDates,
    calendarLines: plan.visits.length,
    bookedServiceRows,
    occupiedResources,
    staffingPoliciesToReview,
    staffingConflictPeriods,
    historicalStaffReservations: importedStaffUnits.size,
    resourcePoliciesToReview,
    resourceConflictPeriods,
    historicalResourceReservations: importedResourceUnits.size,
    serviceLinesWithoutPrice: summarizeNativeBilling(plan.visits).missingPrices.serviceLines,
    crossProfessionalGroups: model.groups.filter(
      (g) => new Set(g.ids.map((id) => planById.get(id)?.item.staffId)).size > 1,
    ).length,
    ...(mode === "rollback"
      ? { rollbackVerified: true, operationalRowsAfterRollback: remaining.count }
      : { candidatePrepared: true, nativeAppointments: remaining.count }),
    canCutOver: false,
  };
}
