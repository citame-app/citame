import {
  appointmentSchema,
  availabilityResponseSchema,
  type CalendarAppointment,
  calendarResponseSchema,
  errorResponseSchema,
  type SyncPushBatch,
  type SyncPushResponse,
  type UpdateAppointmentRequest,
} from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  type Database,
  resourceReservation,
  staffReservation,
} from "@sob/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { IMPORTED_STAFF_UNIT_START } from "../availability/staff-reservations";
import { IMPORTED_RESOURCE_UNIT_START } from "../resources/reservations";
import { collectDesktopAppointments, openRehearsalSyncStream } from "./operational-desktop-check";
import { fingerprint } from "./plan";

export class OperationalMoveProofError extends Error {}

async function readMoveState(db: Database, id: string) {
  const [[visit], services, context, resources] = await Promise.all([
    db.select().from(appointment).where(eq(appointment.id, id)),
    db
      .select()
      .from(appointmentService)
      .where(eq(appointmentService.appointmentId, id))
      .orderBy(asc(appointmentService.position)),
    db
      .select()
      .from(appointmentContext)
      .where(eq(appointmentContext.appointmentId, id))
      .orderBy(asc(appointmentContext.servicePosition)),
    db
      .select()
      .from(resourceReservation)
      .where(and(eq(resourceReservation.appointmentId, id), eq(resourceReservation.active, true)))
      .orderBy(asc(resourceReservation.id)),
  ]);
  if (!visit) throw new OperationalMoveProofError("The imported move target disappeared");
  return { visit, services, context, resources };
}

async function otherAppointments(db: Database, id: string) {
  const [row] = await db.execute<{ digest: string }>(sql`
    select encode(sha256(convert_to(jsonb_build_array(
      (select jsonb_agg(to_jsonb(a) order by a.id) from public.appointment a where a.id <> ${id}),
      (select jsonb_agg(to_jsonb(s) - 'unit_index' order by s.id) from public.staff_reservation s
        where s.appointment_id is distinct from ${id}::uuid),
      (select jsonb_agg(to_jsonb(r) - 'unit_index' order by r.id) from public.resource_reservation r
        where r.appointment_id is distinct from ${id}::uuid)
    )::text, 'UTF8')), 'hex') as digest
  `);
  if (!row) throw new OperationalMoveProofError("The other appointments could not be verified");
  return row.digest;
}

async function moveEffects(db: Database) {
  const [row] = await db.execute<{ digest: string }>(sql`
    select encode(sha256(convert_to(jsonb_build_array(
      (select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_log a),
      (select jsonb_agg(to_jsonb(r) order by r.id) from public.reminder r),
      (select jsonb_agg(to_jsonb(s) order by s.seq) from public.sync_change s)
    )::text, 'UTF8')), 'hex') as digest
  `);
  if (!row) throw new OperationalMoveProofError("The move effects could not be verified");
  return row.digest;
}

async function otherMutationReceipts(db: Database, deviceId: string) {
  const [row] = await db.execute<{ digest: string }>(sql`
    select encode(sha256(convert_to(coalesce(
      jsonb_agg(to_jsonb(m) order by m.mutation_id)::text, '[]'
    ), 'UTF8')), 'hex') as digest
    from public.sync_mutation m where m.device_id is distinct from ${deviceId}
  `);
  if (!row)
    throw new OperationalMoveProofError("The existing mutation receipts could not be verified");
  return row.digest;
}

type OwnerRequest = (
  path: string,
  patch?: UpdateAppointmentRequest,
) => Response | Promise<Response>;
type MoveState = Awaited<ReturnType<typeof readMoveState>>;

async function verifyStoredMove(db: Database, before: MoveState, startsAt: string, others: string) {
  const id = before.visit.id;
  const after = await readMoveState(db, id);
  const staff = await db
    .select()
    .from(staffReservation)
    .where(and(eq(staffReservation.appointmentId, id), eq(staffReservation.active, true)));
  const delta = Date.parse(startsAt) - before.visit.startsAt.getTime();
  const movedSnapshot = {
    ...after.visit,
    startsAt: before.visit.startsAt,
    endsAt: before.visit.endsAt,
    version: before.visit.version,
    updatedAt: before.visit.updatedAt,
  };
  const resourceWindow = (
    { startsAt, endsAt, unitIndex: _unit, ...row }: MoveState["resources"][number],
    shift: number,
  ) => ({
    ...row,
    startsAt: startsAt.getTime() - shift,
    endsAt: endsAt.getTime() - shift,
  });
  if (
    delta === 0 ||
    after.visit.startsAt.getTime() !== Date.parse(startsAt) ||
    after.visit.endsAt.getTime() !== before.visit.endsAt.getTime() + delta ||
    after.visit.version !== before.visit.version + 1 ||
    fingerprint(movedSnapshot) !== fingerprint(before.visit) ||
    fingerprint(after.services) !== fingerprint(before.services) ||
    fingerprint(after.context) !== fingerprint(before.context) ||
    !before.resources.length ||
    !staff.length ||
    staff.some(
      (row) => row.staffId !== before.visit.staffId || row.unitIndex >= IMPORTED_STAFF_UNIT_START,
    ) ||
    after.resources.some((row) => row.unitIndex >= IMPORTED_RESOURCE_UNIT_START) ||
    fingerprint(after.resources.map((row) => resourceWindow(row, delta))) !==
      fingerprint(before.resources.map((row) => resourceWindow(row, 0))) ||
    (await otherAppointments(db, id)) !== others
  )
    throw new OperationalMoveProofError(
      "The move changed frozen details, resources or other appointments",
    );
  return after;
}

async function assertCalendarMove(
  owner: OwnerRequest,
  calendarRoute: string,
  id: string,
  startsAt: string,
  version: number,
) {
  const response = await owner(calendarRoute);
  const calendar = calendarResponseSchema.safeParse(await response.json());
  const visible = calendar.success && calendar.data.appointments.find((item) => item.id === id);
  if (
    response.status !== 200 ||
    !visible ||
    visible.startsAt !== startsAt ||
    visible.version !== version
  )
    throw new OperationalMoveProofError("The web calendar did not reflect the rehearsal move");
}

type RehearsalDesktopPush = {
  deviceId: string;
  generation: string;
  push: (batch: SyncPushBatch) => Promise<SyncPushResponse>;
};

async function rehearseDesktopMove(
  db: Database,
  owner: OwnerRequest,
  calendarRoute: string,
  desktop: RehearsalDesktopPush,
  before: MoveState,
  destinations: string[],
  others: string,
) {
  const { id, version, updatedAt } = before.visit;
  const receipts = await otherMutationReceipts(db, desktop.deviceId);
  const stream = await openRehearsalSyncStream(owner, desktop.generation, "Web");
  try {
    const startingHead = await stream.next();
    for (const startsAt of destinations) {
      const mutation = {
        kind: "appointment.reschedule" as const,
        mutationId: Bun.randomUUIDv7(),
        createdAt: updatedAt.toISOString(),
        payload: { id, version, startsAt },
      };
      const batch: SyncPushBatch = {
        deviceId: desktop.deviceId,
        generation: desktop.generation,
        mutations: [mutation],
      };
      const {
        results: [applied],
      } = await desktop.push(batch);
      if (
        applied?.status === "rejected" &&
        ["slot_taken", "slot_unavailable"].includes(applied.reason)
      )
        continue;
      if (
        applied?.status !== "applied" ||
        applied.mutationId !== mutation.mutationId ||
        applied.replayed ||
        applied.appliedSeq === null ||
        applied.appliedSeq <= startingHead
      )
        throw new OperationalMoveProofError(
          "The linked device could not move the imported appointment",
        );

      const next = await stream.next();
      if (next < applied.appliedSeq)
        throw new OperationalMoveProofError("The web session missed the desktop's live change");
      await assertCalendarMove(owner, calendarRoute, id, startsAt, version + 1);
      const moved = await verifyStoredMove(db, before, startsAt, others);
      const storedEffects = await moveEffects(db);
      const {
        results: [replayed],
      } = await desktop.push(batch);
      const staleMutationId = Bun.randomUUIDv7();
      const {
        results: [stale],
      } = await desktop.push({
        ...batch,
        mutations: [{ ...mutation, mutationId: staleMutationId }],
      });
      if (
        replayed?.status !== "applied" ||
        replayed.mutationId !== mutation.mutationId ||
        !replayed.replayed ||
        replayed.appliedSeq !== applied.appliedSeq ||
        stale?.status !== "rejected" ||
        stale.mutationId !== staleMutationId ||
        stale.reason !== "conflict" ||
        stale.replayed ||
        fingerprint(await readMoveState(db, id)) !== fingerprint(moved) ||
        (await moveEffects(db)) !== storedEffects ||
        (await otherMutationReceipts(db, desktop.deviceId)) !== receipts
      )
        throw new OperationalMoveProofError(
          "The desktop retry or stale edit changed the import twice",
        );
      return;
    }
    throw new OperationalMoveProofError("The linked device had no available second move");
  } finally {
    await stream.close();
  }
}

export async function rehearseNativeCalendarMove(
  db: Database,
  owner: OwnerRequest,
  date: string,
  calendarRoute: string,
  visits: CalendarAppointment[],
  desktop: RehearsalDesktopPush & {
    get: (path: string) => Response | Promise<Response>;
    renew: () => Promise<void>;
    generation: string;
    cursor: number;
    stream: { next: () => Promise<number> };
    startingHead: number;
  },
) {
  for (const visit of visits) {
    if (
      visit.status !== "booked" ||
      !visit.resources?.length ||
      !visit.services.length ||
      visit.services.some((item) => !item.serviceId)
    )
      continue;
    const serviceIds = visit.services.map((item) => item.serviceId).join(",");
    const query = new URLSearchParams({ date, serviceIds, staffId: visit.staffId });
    const path = `/appointments/${visit.id}`;
    const availability = await owner(`${path}/availability?${query}`);
    if (availability.status !== 200)
      throw new OperationalMoveProofError("The imported reschedule availability request failed");
    const slots = availabilityResponseSchema.safeParse(await availability.json());
    if (!slots.success)
      throw new OperationalMoveProofError("The reschedule availability was invalid");
    const destinations = slots.data.slots.filter((slot) => slot.startsAt !== visit.startsAt);
    if (slots.data.slots.length < 2 || !destinations.length) continue;

    const before = await readMoveState(db, visit.id);
    const others = await otherAppointments(db, visit.id);
    for (const slot of destinations) {
      const patch = { startsAt: slot.startsAt, version: visit.version };
      const response = await owner(path, patch);
      if (response.status !== 200) {
        const failure = errorResponseSchema.safeParse(await response.json());
        if (failure.success && ["slot_taken", "slot_unavailable"].includes(failure.data.error.code))
          continue;
        throw new OperationalMoveProofError(
          "The imported appointment could not be moved through the API",
        );
      }
      const moved = appointmentSchema.safeParse(await response.json());
      const after = await verifyStoredMove(db, before, slot.startsAt, others);
      const effects = await moveEffects(db);
      const stale = await owner(path, { startsAt: visit.startsAt, version: visit.version });
      const staleBody = errorResponseSchema.safeParse(await stale.json());
      if (
        stale.status !== 409 ||
        !staleBody.success ||
        staleBody.data.error.code !== "version_conflict" ||
        fingerprint(await readMoveState(db, visit.id)) !== fingerprint(after) ||
        (await moveEffects(db)) !== effects
      )
        throw new OperationalMoveProofError("The move accepted a stale appointment version");

      if (
        !moved.success ||
        moved.data.id !== visit.id ||
        moved.data.startsAt !== slot.startsAt ||
        moved.data.version !== visit.version + 1
      )
        throw new OperationalMoveProofError("The web move did not return the updated appointment");
      await assertCalendarMove(owner, calendarRoute, visit.id, slot.startsAt, visit.version + 1);
      const nudge = await desktop.stream.next();
      await desktop.renew();
      const replica = await collectDesktopAppointments(
        desktop.get,
        desktop.generation,
        desktop.cursor,
      );
      const replayed = replica.appointments.get(visit.id);
      if (
        !replayed ||
        replayed.data.startsAt !== slot.startsAt ||
        replayed.data.version !== visit.version + 1 ||
        replayed.seq > nudge ||
        nudge <= desktop.startingHead
      )
        throw new OperationalMoveProofError("The desktop sync feed did not reflect the web move");
      await rehearseDesktopMove(
        db,
        owner,
        calendarRoute,
        desktop,
        after,
        slots.data.slots
          .map((destination) => destination.startsAt)
          .filter((start) => start !== slot.startsAt),
        others,
      );
      return {
        movedThroughApi: true,
        staleVersionRejected: true,
        resourceAssignments: after.resources.length,
        calendarUpdated: true,
        replicaUpdated: true,
        deviceProofRenewed: true,
        desktopLiveChangeReceived: true,
        movedThroughDesktop: true,
        webLiveChangeReceived: true,
        desktopReplayIdempotent: true,
        staleDesktopVersionRejected: true,
      };
    }
  }
  throw new OperationalMoveProofError(
    "No resource-backed imported appointment had two available rehearsal slots",
  );
}
