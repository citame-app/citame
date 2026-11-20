import { createCheckoutSchema } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  checkout,
  clientProfile,
  type Database,
  resourceReservation,
  service,
  serviceResource,
  serviceStaff,
  staffProfile,
  staffReservation,
  user,
  workingHours,
} from "@sob/db";
import { and, asc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { createAppointment, updateAppointment } from "../appointments/service";
import { findAvailability } from "../availability/service";
import { IMPORTED_STAFF_UNIT_START } from "../availability/staff-reservations";
import { appointmentBillingHolds } from "../commerce/appointment-billing";
import { createCheckoutInTransaction } from "../commerce/service";
import { IMPORTED_RESOURCE_UNIT_START } from "../resources/reservations";
import { getSalonSettings } from "../settings/service";
import { mustReject } from "./rehearsal-assert";
import { checkRestoredStock } from "./stock-check";
import { checkRestoredWaitlist } from "./waitlist-check";

type SaturatedStart = {
  id: string;
  starts_at: Date;
};

/** Historical units alone do not imply a conflict. Count real overlapping demand at each start. */
async function overloadedStarts(tx: Tx, from: Date, to: Date, step: number) {
  const grid = sql`generate_series(${from}::timestamptz,
    ${to}::timestamptz - make_interval(mins => ${step}),make_interval(mins => ${step}))`;
  const staff = await tx.execute<SaturatedStart>(sql`
    select r.staff_id as id, grid.starts_at
    from ${grid} as grid(starts_at)
    join staff_reservation r on r.active and r.starts_at<=grid.starts_at and r.ends_at>grid.starts_at
    join staff_profile p on p.id=r.staff_id and p.active and p.deleted_at is null
    group by r.staff_id,grid.starts_at,p.max_concurrent
    having count(*)>p.max_concurrent and bool_or(r.unit_index>=${IMPORTED_STAFF_UNIT_START})
    order by grid.starts_at,r.staff_id
  `);
  const equipment = await tx.execute<SaturatedStart>(sql`
    select r.resource_id as id,grid.starts_at
    from ${grid} as grid(starts_at)
    join resource_reservation r on r.active and r.starts_at<=grid.starts_at and r.ends_at>grid.starts_at
    join resource_pool p on p.id=r.resource_id and p.active
    group by r.resource_id,grid.starts_at,p.capacity
    having count(*)>p.capacity and bool_or(r.unit_index>=${IMPORTED_RESOURCE_UNIT_START})
    order by grid.starts_at,r.resource_id
  `);
  return { staff, equipment };
}

async function prepareRecoveryOperator(tx: Tx): Promise<Principal> {
  const operator: Principal = {
    userId: Bun.randomUUIDv7(),
    name: "Synthetic recovery operator",
    email: "schedule-probe@example.invalid",
    role: "owner",
    staffId: null,
    clientId: null,
  };
  await tx.insert(user).values({
    id: operator.userId,
    name: operator.name,
    email: operator.email,
    role: operator.role,
  });
  return operator;
}

async function checkImportedOperations(
  tx: Tx,
  midnight: Temporal.ZonedDateTime,
  step: number,
  operator: Principal,
) {
  const from = new Date(midnight.epochMilliseconds);
  const to = new Date(midnight.add({ days: 1 }).epochMilliseconds);
  const now = new Date(midnight.subtract({ days: 1 }).epochMilliseconds);
  const checkoutAppointment = (appointmentId: string, connection: Tx = tx) =>
    createCheckoutInTransaction(
      connection,
      createCheckoutSchema.parse({ appointmentId, idempotencyKey: Bun.randomUUIDv7() }),
      operator,
    );

  const unpriced = await tx
    .selectDistinct({ id: appointmentService.appointmentId })
    .from(appointmentService)
    .where(
      and(
        eq(appointmentService.sourceUnpriced, true),
        isNull(appointmentService.reviewedPriceCents),
      ),
    );
  const external = await tx
    .selectDistinct({ id: appointmentContext.appointmentId })
    .from(appointmentContext)
    .where(
      and(
        eq(appointmentContext.source, "booksy"),
        or(eq(appointmentContext.paid, true), eq(appointmentContext.invoiced, true)),
      ),
    );
  const held = await appointmentBillingHolds(
    tx,
    [...unpriced, ...external].map(({ id }) => id),
  );
  for (const id of held) {
    await mustReject(
      () => checkoutAppointment(id),
      "invalid_state",
      "Reconcile the imported price, payment or invoice before collecting this appointment",
    );
  }
  const [receiptsBefore] = await tx.select({ count: sql<number>`count(*)::int` }).from(checkout);
  if (receiptsBefore?.count !== 0) throw new Error("A held appointment created a receipt");

  const sourceDay = await tx
    .select({
      visit: appointment,
      bookingAccess: clientProfile.bookingAccess,
      hasEquipment: sql<boolean>`exists (select 1 from ${resourceReservation} where ${resourceReservation.appointmentId}=${appointment.id} and ${resourceReservation.active})`,
      historicalEquipment: sql<boolean>`exists (select 1 from ${resourceReservation} where ${resourceReservation.appointmentId}=${appointment.id} and ${resourceReservation.active} and ${resourceReservation.unitIndex} >= ${IMPORTED_RESOURCE_UNIT_START})`,
      historicalStaff: sql<boolean>`exists (select 1 from ${staffReservation} where ${staffReservation.appointmentId}=${appointment.id} and ${staffReservation.active} and ${staffReservation.unitIndex} >= ${IMPORTED_STAFF_UNIT_START})`,
      hasPositiveService: sql<boolean>`exists (select 1 from ${appointmentService} where ${appointmentService.appointmentId}=${appointment.id} and ${appointmentService.serviceId} is not null and coalesce(${appointmentService.reviewedPriceCents},${appointmentService.priceCents})>0)`,
    })
    .from(appointment)
    .innerJoin(clientProfile, eq(clientProfile.id, appointment.clientId))
    .where(
      and(
        eq(appointment.status, "booked"),
        isNull(appointment.deletedAt),
        gte(appointment.startsAt, from),
        lt(appointment.startsAt, to),
        sql`exists (select 1 from ${appointmentContext} where ${appointmentContext.appointmentId}=${appointment.id} and ${appointmentContext.source}='booksy')`,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id));
  const dayHolds = await appointmentBillingHolds(
    tx,
    sourceDay.map(({ visit }) => visit.id),
  );
  // Prefer a visit that exercises both conversions, while reporting precisely which were covered.
  const historyCount = ({ historicalEquipment, historicalStaff }: (typeof sourceDay)[number]) =>
    Number(historicalEquipment) + Number(historicalStaff);
  sourceDay.sort((a, b) => historyCount(b) - historyCount(a));
  const target = sourceDay.find(
    ({ visit, bookingAccess, hasEquipment, hasPositiveService }) =>
      bookingAccess !== "blocked" &&
      hasEquipment &&
      hasPositiveService &&
      !dayHolds.has(visit.id) &&
      visit.endsAt.getTime() - visit.startsAt.getTime() < to.getTime() - from.getTime(),
  );
  if (!target) throw new Error("Expected a priced imported appointment for the operation control");
  const { visit } = target;
  const services = () =>
    tx
      .select()
      .from(appointmentService)
      .where(eq(appointmentService.appointmentId, visit.id))
      .orderBy(asc(appointmentService.position));
  const contexts = () =>
    tx
      .select()
      .from(appointmentContext)
      .where(eq(appointmentContext.appointmentId, visit.id))
      .orderBy(asc(appointmentContext.id));
  const lines = await services();
  const annotations = await contexts();
  const resources = () =>
    tx
      .select()
      .from(resourceReservation)
      .where(
        and(eq(resourceReservation.appointmentId, visit.id), eq(resourceReservation.active, true)),
      )
      .orderBy(asc(resourceReservation.id));
  const equipment = await resources();

  const [destination] = await tx
    .insert(staffProfile)
    .values({ displayName: "Synthetic move destination" })
    .returning({ id: staffProfile.id });
  if (!destination) throw new Error("Could not create a synthetic move destination");
  await tx.insert(workingHours).values({
    staffId: destination.id,
    weekday: midnight.dayOfWeek % 7,
    startTime: "00:00",
    endTime: "23:59",
  });
  const moveTo = (startsAt: string) =>
    updateAppointment(
      tx,
      visit.id,
      { startsAt, staffId: destination.id, version: visit.version },
      operator,
      { now },
    );
  const serviceIds = [...new Set(lines.flatMap(({ serviceId }) => (serviceId ? [serviceId] : [])))];
  await mustReject(
    () => moveTo(visit.startsAt.toISOString()),
    "validation_error",
    "The staff member does not perform every selected service",
  );
  await tx
    .insert(serviceStaff)
    .values(serviceIds.map((serviceId) => ({ staffId: destination.id, serviceId })));
  const duration = visit.endsAt.getTime() - visit.startsAt.getTime();
  let moved: Awaited<ReturnType<typeof updateAppointment>> | undefined;
  // Use the frozen appointment and resource windows through the real move service.
  for (
    let candidate = from.getTime();
    candidate + duration < to.getTime();
    candidate += step * 60000
  ) {
    if (candidate === visit.startsAt.getTime()) continue;
    try {
      moved = await moveTo(new Date(candidate).toISOString());
      break;
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "slot_unavailable")) throw error;
    }
  }
  if (!moved)
    throw new Error("No free destination was verified for the priced imported appointment");
  await mustReject(
    () =>
      updateAppointment(
        tx,
        visit.id,
        { version: visit.version, startsAt: visit.startsAt.toISOString() },
        operator,
        { now },
      ),
    "version_conflict",
  );
  const movedEquipment = await resources();
  const [movedRow] = await tx.select().from(appointment).where(eq(appointment.id, visit.id));
  const delta = Date.parse(moved.startsAt) - visit.startsAt.getTime();
  if (
    !movedRow ||
    moved.version !== visit.version + 1 ||
    delta === 0 ||
    moved.staffId !== destination.id ||
    (moved.visitGroupId ?? null) !== visit.visitGroupId ||
    Date.parse(moved.endsAt) !== visit.endsAt.getTime() + delta ||
    movedRow.clientId !== visit.clientId ||
    movedRow.sourceBusinessMessage !== visit.sourceBusinessMessage ||
    movedRow.customerComment !== visit.customerComment ||
    movedRow.requestedStaffId !== visit.requestedStaffId ||
    movedRow.notes !== visit.notes ||
    JSON.stringify(movedRow.workWindows) !== JSON.stringify(visit.workWindows) ||
    JSON.stringify(await services()) !== JSON.stringify(lines) ||
    JSON.stringify(await contexts()) !== JSON.stringify(annotations) ||
    movedEquipment.length !== equipment.length ||
    movedEquipment.some((row, index) => {
      const prior = equipment[index]!;
      return (
        row.id !== prior.id ||
        row.resourceId !== prior.resourceId ||
        row.servicePosition !== prior.servicePosition ||
        row.offsetMinutes !== prior.offsetMinutes ||
        row.endOffsetMinutes !== prior.endOffsetMinutes ||
        row.startsAt.getTime() !== prior.startsAt.getTime() + delta ||
        row.endsAt.getTime() !== prior.endsAt.getTime() + delta ||
        row.unitIndex >= IMPORTED_RESOURCE_UNIT_START
      );
    })
  )
    throw new Error("The reschedule did not preserve the imported appointment details");

  const ordinaryStaff = await tx
    .select()
    .from(staffReservation)
    .where(and(eq(staffReservation.appointmentId, visit.id), eq(staffReservation.active, true)));
  if (
    !ordinaryStaff.length ||
    ordinaryStaff.some(
      (row) => row.staffId !== destination.id || row.unitIndex >= IMPORTED_STAFF_UNIT_START,
    )
  )
    throw new Error("The rescheduled visit did not use ordinary destination capacity");

  const [sourceContext] = annotations.filter((row) => row.source === "booksy");
  if (!sourceContext) throw new Error("Expected an imported annotation for the billing control");
  const rollbackFlag = new Error("Revert synthetic source billing flag");
  let syntheticSourcePaymentHoldsRejected = 0;
  for (const flag of [{ paid: true }, { invoiced: true }]) {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(appointmentContext)
          .set(flag)
          .where(eq(appointmentContext.id, sourceContext.id));
        await mustReject(
          () => checkoutAppointment(visit.id, savepoint),
          "invalid_state",
          "Reconcile the imported price, payment or invoice before collecting this appointment",
        );
        throw rollbackFlag;
      });
    } catch (error) {
      if (error !== rollbackFlag) throw error;
      syntheticSourcePaymentHoldsRejected++;
    }
  }
  if (JSON.stringify(await contexts()) !== JSON.stringify(annotations))
    throw new Error("A synthetic billing marker changed the original annotations");

  const priced = await checkoutAppointment(visit.id);
  const frozenTotal = lines.reduce(
    (total, line) => total + (line.reviewedPriceCents ?? line.priceCents),
    0,
  );
  if (
    priced.totalCents !== frozenTotal ||
    priced.balanceCents !== frozenTotal ||
    priced.paidCents !== 0 ||
    priced.payments.length !== 0
  )
    throw new Error("The checkout did not preserve the frozen, unpaid balance after rescheduling");
  return {
    unpricedAppointmentsBlocked: unpriced.length,
    flaggedPaymentOrInvoiceAppointments: external.length,
    heldCheckoutAttemptsRejected: held.size,
    syntheticSourcePaymentHoldsRejected,
    importedMovePreservedServiceAndContext: true,
    importedMoveResourceAssignments: movedEquipment.length,
    importedMoveConvertedHistoricalStaff: target.historicalStaff,
    importedMoveConvertedHistoricalEquipment: target.historicalEquipment,
    unqualifiedMoveRejected: true,
    staleMoveRejected: true,
    ordinaryCheckoutMatchedFrozenPrice: true,
  };
}

async function checkCapacity(tx: Tx, date: string) {
  const settings = await getSalonSettings(tx);
  const day = Temporal.PlainDate.from(date);
  const midnight = day.toZonedDateTime(settings.timezone);
  const from = new Date(midnight.epochMilliseconds);
  const to = new Date(midnight.add({ days: 1 }).epochMilliseconds);
  const now = new Date(midnight.subtract({ days: 1 }).epochMilliseconds);
  const step = settings.slotGranularityMinutes;
  const saturated = await overloadedStarts(tx, from, to, step);
  if (!saturated.staff.length || !saturated.equipment.length)
    throw new Error("Choose a captured day with both staff and equipment overloads");

  const [probeClient] = await tx
    .insert(clientProfile)
    .values({ name: "Synthetic recovery probe" })
    .returning({ id: clientProfile.id });
  const [equipmentOperator] = await tx
    .insert(staffProfile)
    .values({ displayName: "Synthetic equipment probe" })
    .returning({ id: staffProfile.id });
  if (!probeClient || !equipmentOperator) throw new Error("Could not create synthetic probes");
  // Give this temporary operator enough hours to isolate the existing equipment demand.
  await tx.insert(workingHours).values({
    staffId: equipmentOperator.id,
    weekday: day.dayOfWeek % 7,
    startTime: "00:00",
    endTime: "23:59",
  });

  const prepareService = async (staffIds: string[], resourceId?: string) => {
    const [probe] = await tx
      .insert(service)
      .values({
        name: "Synthetic capacity probe",
        durationMinutes: step,
        priceCents: 100,
        currency: "EUR",
      })
      .returning({ id: service.id });
    if (!probe) throw new Error("Could not create synthetic service");
    await tx
      .insert(serviceStaff)
      .values(staffIds.map((staffId) => ({ staffId, serviceId: probe.id })));
    if (resourceId)
      await tx.insert(serviceResource).values({ serviceId: probe.id, resourceId, quantity: 1 });
    return probe.id;
  };
  const book = (staffId: string, serviceId: string, startsAt: string) =>
    createAppointment(
      tx,
      { staffId, serviceIds: [serviceId], clientId: probeClient.id, startsAt },
      undefined,
      { now },
    );
  const availability = (staffId: string, serviceId: string) =>
    findAvailability(tx, { date, staffId, serviceIds: [serviceId] }, now);

  // Keep checking every overloaded professional, even if none has a free slot for the control.
  const activeStaff = await tx
    .select({ id: staffProfile.id })
    .from(staffProfile)
    .where(
      and(
        eq(staffProfile.active, true),
        isNull(staffProfile.deletedAt),
        ne(staffProfile.id, equipmentOperator.id),
      ),
    )
    .orderBy(asc(staffProfile.id));
  const staffIds = [...new Set([...saturated.staff, ...activeStaff].map(({ id }) => id))];
  const staffService = await prepareService(staffIds);
  let ordinaryStaffBooking = false;
  for (const id of staffIds) {
    const overloaded = saturated.staff.filter((item) => item.id === id);
    if (ordinaryStaffBooking && !overloaded.length) continue;
    const { slots } = await availability(id, staffService);
    for (const row of overloaded) {
      const begins = new Date(row.starts_at).toISOString();
      if (slots.some((slot) => slot.startsAt === begins))
        throw new Error("Availability offered an overloaded professional slot");
      await mustReject(() => book(id, staffService, begins), "slot_taken");
    }
    if (!ordinaryStaffBooking && slots[0]) {
      const created = await book(id, staffService, slots[0].startsAt);
      const rows = await tx
        .select()
        .from(staffReservation)
        .where(eq(staffReservation.appointmentId, created.id));
      ordinaryStaffBooking = rows.length === 1 && rows[0]!.unitIndex < IMPORTED_STAFF_UNIT_START;
    }
  }
  if (!ordinaryStaffBooking) throw new Error("No ordinary professional reservation was verified");

  const resources = [...new Set(saturated.equipment.map((row) => row.id))];
  let equipmentControl: { resourceId: string; serviceId: string; startsAt: string } | undefined;
  for (const resourceId of resources) {
    const equipmentService = await prepareService([equipmentOperator.id], resourceId);
    const { slots } = await availability(equipmentOperator.id, equipmentService);
    for (const row of saturated.equipment.filter((item) => item.id === resourceId)) {
      const begins = new Date(row.starts_at).toISOString();
      if (slots.some((slot) => slot.startsAt === begins))
        throw new Error("Availability offered an overloaded equipment slot");
      await mustReject(
        () => book(equipmentOperator.id, equipmentService, begins),
        "slot_unavailable",
        "The required room or equipment has no capacity at this time",
      );
    }
    if (!equipmentControl && slots[0])
      equipmentControl = { resourceId, serviceId: equipmentService, startsAt: slots[0].startsAt };
  }
  if (!equipmentControl) throw new Error("No free equipment slot was verified");
  const created = await book(
    equipmentOperator.id,
    equipmentControl.serviceId,
    equipmentControl.startsAt,
  );
  const rows = await tx
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.appointmentId, created.id));
  const ordinaryEquipmentBooking =
    rows.length === 1 &&
    rows[0]!.resourceId === equipmentControl.resourceId &&
    rows[0]!.unitIndex < IMPORTED_RESOURCE_UNIT_START;
  if (!ordinaryEquipmentBooking) throw new Error("No ordinary equipment reservation was verified");

  const operator = await prepareRecoveryOperator(tx);
  const operations = await checkImportedOperations(tx, midnight, step, operator);
  const inventory = await checkRestoredStock(tx, operator);
  const waitlist = await checkRestoredWaitlist(tx, operator);
  await tx.execute(sql`set constraints all immediate`);
  return {
    date,
    professionalStartsRejected: saturated.staff.length,
    equipmentStartsRejected: saturated.equipment.length,
    ordinaryStaffBooking,
    ordinaryEquipmentBooking,
    ...operations,
    inventory,
    waitlist,
  };
}

/** Invoke only in the disposable restore command, after verifying the dump and source snapshot. */
export async function rehearseRestoredSchedule(db: Database, date: string) {
  const rollback = new Error("Revert synthetic bookings");
  let proof: Awaited<ReturnType<typeof checkCapacity>> | undefined;
  try {
    await db.transaction(async (tx) => {
      const [identity] = await tx.execute<{ name: string }>(sql`select current_database() as name`);
      if (!/^sob_booksy_restorecheck_\d{8}_\d+$/.test(identity?.name ?? ""))
        throw new Error("Schedule rehearsal requires a private restore");
      await lockScheduling(tx);
      proof = await checkCapacity(tx, date);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!proof) throw new Error("No scheduling proof was produced");
  return { ...proof, rollbackVerified: true };
}
