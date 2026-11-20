import { waitlistInputSchema } from "@sob/contracts";
import {
  clientProfile,
  reminder,
  service,
  serviceStaff,
  staffProfile,
  waitlistEntry,
  waitlistOffer,
  waitlistSourceEntry,
  workingHours,
} from "@sob/db";
import { asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../../auth/principal";
import type { Tx } from "../../tx";
import { findAvailability } from "../availability/service";
import { getSalonSettings } from "../settings/service";
import { runWaitlist } from "../waitlist/matching";
import { getWaitlistPolicy, joinWaitlist, setWaitlistPolicy } from "../waitlist/service";
import { mustReject } from "./rehearsal-assert";

export const restoredWaitlistEvidenceSchema = z.object({
  sourceRequests: z.number().int().nonnegative(),
  preparedOnce: z.number().int().nonnegative(),
  availableControls: z.number().int().nonnegative(),
  enabledPolicyRejections: z.number().int().nonnegative(),
  missingStaffPreferenceRejections: z.number().int().nonnegative(),
  anyProfessionalAccepted: z.number().int().nonnegative(),
  replaysWhileEnabled: z.number().int().nonnegative(),
  originalsUnchanged: z.literal(true),
  policyPaused: z.literal(true),
  entriesScanned: z.literal(0),
  offersCreated: z.literal(0),
  remindersCreated: z.literal(0),
});

/** Use synthetic clients and catalog selections inside the caller's rollback transaction. */
export async function checkRestoredWaitlist(
  tx: Tx,
  operator: Principal,
): Promise<z.infer<typeof restoredWaitlistEvidenceSchema>> {
  if ((await getWaitlistPolicy(tx)).enabled)
    throw new Error("The restored collection must keep waitlist offers paused");
  const [offersBefore] = await tx.select({ n: count() }).from(waitlistOffer);
  const [remindersBefore] = await tx.select({ n: count() }).from(reminder);
  const [entriesBefore] = await tx.select({ n: count() }).from(waitlistEntry);
  const originals = await tx
    .select()
    .from(waitlistSourceEntry)
    .orderBy(asc(waitlistSourceEntry.id));
  if (originals.some((row) => row.linkedEntryId))
    throw new Error("The restored collection already has linked imported waitlist entries");
  const settings = await getSalonSettings(tx);
  const links: string[] = [];
  const setOffersEnabled = async (enabled: boolean) => {
    const policy = await getWaitlistPolicy(tx);
    await setWaitlistPolicy(tx, { ...policy, enabled }, operator);
  };
  let scanAt: Date | undefined;
  for (const original of originals) {
    const [client] = await tx
      .insert(clientProfile)
      .values({ name: "Synthetic waitlist client" })
      .returning({ id: clientProfile.id });
    const [professional] = await tx
      .insert(staffProfile)
      .values({ displayName: "Synthetic waitlist professional" })
      .returning({ id: staffProfile.id });
    const bufferMinutes = Math.min(5, original.durationMinutes - 1);
    const [matched, other] = await tx
      .insert(service)
      .values([
        {
          name: "Synthetic matching service",
          durationMinutes: original.durationMinutes - bufferMinutes,
          bufferMinutes,
          currency: "EUR",
          priceCents: 100,
        },
        {
          name: "Synthetic longer service",
          durationMinutes: original.durationMinutes - bufferMinutes,
          bufferMinutes: bufferMinutes + 1,
          currency: "EUR",
          priceCents: 100,
        },
      ])
      .returning({ id: service.id });
    if (!client || !professional || !matched || !other)
      throw new Error("Unable to create synthetic waitlist controls");
    await tx
      .insert(serviceStaff)
      .values([matched, other].map(({ id }) => ({ serviceId: id, staffId: professional.id })));
    const sourceId = Bun.randomUUIDv7();
    await tx.insert(waitlistSourceEntry).values({
      ...original,
      id: sourceId,
      clientId: client.id,
    });
    const day = Temporal.PlainDate.from(original.requestedDate);
    const now = new Date(day.toZonedDateTime(settings.timezone).epochMilliseconds);
    if (!scanAt || now > scanAt) scanAt = now;
    const selection = waitlistInputSchema.parse({
      serviceIds: [matched.id],
      staffId: null,
      fromDate: original.requestedDate,
      toDate: original.requestedDate,
      fromTime: "08:00",
      toTime: "23:55",
      idempotencyKey: Bun.randomUUIDv7(),
    });
    await tx.insert(workingHours).values({
      staffId: professional.id,
      weekday: day.dayOfWeek % 7,
      startTime: selection.fromTime,
      endTime: selection.toTime,
    });
    const available = await findAvailability(
      tx,
      {
        date: original.requestedDate,
        serviceIds: selection.serviceIds,
        staffId: professional.id,
      },
      now,
    );
    if (!available.slots.length)
      throw new Error(
        "The synthetic waitlist control should have an open slot while the queue is paused",
      );
    const submit = (input = selection, clientId = client.id) =>
      joinWaitlist(tx, input, operator, now, clientId, sourceId);
    const nextDate = day.add({ days: 1 }).toString();
    await mustReject(
      () =>
        joinWaitlist(
          tx,
          selection,
          {
            ...operator,
            role: "staff",
            accessPreset: "restricted",
            staffId: professional.id,
          },
          now,
          client.id,
          sourceId,
        ),
      "forbidden",
    );
    await mustReject(() => submit(selection, Bun.randomUUIDv7()), "not_found");
    await mustReject(
      () => submit({ ...selection, fromDate: nextDate, toDate: nextDate }),
      "validation_error",
      "Use the date from the imported request",
    );
    await mustReject(
      () => submit({ ...selection, serviceIds: [other.id] }),
      "validation_error",
      "The selected services must match the imported slot duration",
    );
    await mustReject(
      () => submit({ ...selection, staffId: undefined }),
      "validation_error",
      "Confirm the imported request's staff preference",
    );
    await setOffersEnabled(true);
    await mustReject(
      () => submit(),
      "invalid_state",
      "Pause automatic offers before importing a waitlist request",
    );
    await setOffersEnabled(false);
    const entry = await submit();
    await setOffersEnabled(true);
    const replay = await submit();
    await setOffersEnabled(false);
    await mustReject(
      () => submit({ ...selection, fromTime: "08:05" }),
      "invalid_state",
      "This request key has already been used",
    );
    await mustReject(
      () => submit({ ...selection, idempotencyKey: Bun.randomUUIDv7() }),
      "version_conflict",
    );
    const [linked] = await tx
      .select()
      .from(waitlistSourceEntry)
      .where(eq(waitlistSourceEntry.id, sourceId));
    if (
      replay.id !== entry.id ||
      replay.version !== entry.version ||
      entry.state !== "waiting" ||
      entry.offer !== null ||
      linked?.linkedEntryId !== entry.id ||
      linked.requestedDate !== original.requestedDate ||
      linked.durationMinutes !== original.durationMinutes ||
      linked.flexible !== original.flexible ||
      linked.sourceOrder !== original.sourceOrder ||
      linked.sourceHash !== original.sourceHash ||
      linked.capturedAt.getTime() !== original.capturedAt.getTime() ||
      entry.clientId !== client.id ||
      entry.staffId !== null ||
      entry.serviceIds.length !== 1 ||
      entry.serviceIds[0] !== matched.id ||
      entry.fromDate !== original.requestedDate ||
      entry.toDate !== original.requestedDate ||
      entry.fromTime !== selection.fromTime ||
      entry.toTime !== selection.toTime
    )
      throw new Error("The proposed waitlist entry did not preserve the reviewed request");
    links.push(entry.id);
  }

  const result = await runWaitlist(tx, { now: scanAt });
  const [offersAfter] = await tx.select({ n: count() }).from(waitlistOffer);
  const [remindersAfter] = await tx.select({ n: count() }).from(reminder);
  const [entriesAfter] = await tx.select({ n: count() }).from(waitlistEntry);
  const linkedEntries = links.length
    ? await tx.select().from(waitlistEntry).where(inArray(waitlistEntry.id, links))
    : [];
  const originalRows = originals.length
    ? await tx
        .select()
        .from(waitlistSourceEntry)
        .where(
          inArray(
            waitlistSourceEntry.id,
            originals.map(({ id }) => id),
          ),
        )
        .orderBy(asc(waitlistSourceEntry.id))
    : [];
  if (JSON.stringify(originalRows) !== JSON.stringify(originals))
    throw new Error("The waitlist rehearsal changed or linked an original");
  if (
    result.entriesScanned !== 0 ||
    result.offersCreated !== 0 ||
    (await getWaitlistPolicy(tx)).enabled ||
    offersBefore?.n !== offersAfter?.n ||
    remindersBefore?.n !== remindersAfter?.n ||
    entriesAfter?.n !== (entriesBefore?.n ?? 0) + originals.length ||
    linkedEntries.length !== originals.length ||
    linkedEntries.some(({ lastScannedAt, state }) => lastScannedAt !== null || state !== "waiting")
  )
    throw new Error("The paused waitlist changed an entry, offer or reminder");
  return {
    sourceRequests: originals.length,
    preparedOnce: linkedEntries.length,
    availableControls: originals.length,
    enabledPolicyRejections: originals.length,
    missingStaffPreferenceRejections: originals.length,
    anyProfessionalAccepted: linkedEntries.length,
    replaysWhileEnabled: originals.length,
    originalsUnchanged: true,
    policyPaused: true,
    entriesScanned: result.entriesScanned,
    offersCreated: 0,
    remindersCreated: 0,
  };
}
