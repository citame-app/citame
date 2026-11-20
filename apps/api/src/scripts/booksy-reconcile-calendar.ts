import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { fingerprint, sourceUuid } from "../modules/booksy-transfer/plan";
import {
  type BooksySourceReadModel,
  sourceInstant,
} from "../modules/booksy-transfer/source-read-model";
import {
  privateWriteVerified,
  readPrivateArchiveFile,
  readPrivateBooksySnapshot,
} from "../modules/booksy-transfer/vault";

const cardIdentitySchema = z.strictObject({
  itemElementId: z.string().regex(/^cc-\d+$/),
  appointmentAttribute: z.string().regex(/^\d+$/),
  columnResource: z.string().regex(/^\d+$/),
});
const cardSchema = cardIdentitySchema.extend({
  interval: z.string().regex(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}$/),
});
const observationSchema = z.strictObject({
  capturedAt: z.iso.datetime(),
  source: z.literal("booksy_visible_calendar"),
  date: z.iso.date(),
  timezone: z.literal("Europe/Madrid"),
  filter: z.enum(["working", "all"]),
  staffResources: z.array(z.string().regex(/^\d+$/)).optional(),
  cards: z.array(cardSchema),
  cardsWithoutVisibleTimes: z.array(cardIdentitySchema).optional(),
  staffBlocks: z.array(cardSchema).optional(),
});

export function reconcileObservedCalendar(model: BooksySourceReadModel, rawObservation: unknown) {
  const observation = observationSchema.parse(rawObservation);
  if (observation.date < model.fromDate || observation.date > model.throughDate)
    throw new Error("Calendar observation is outside the source snapshot");

  const date = Temporal.PlainDate.from(observation.date);
  const from = Date.parse(sourceInstant(`${date}T00:00`));
  const to = Date.parse(sourceInstant(`${date.add({ days: 1 })}T00:00`));
  const items = new Map(
    model.appointments
      .filter((row) => Date.parse(row.startsAt) >= from && Date.parse(row.startsAt) < to)
      .map((row) => [row.sourceCopy?.itemRef, row]),
  );
  const staff = new Map(
    model.base.staff.map((row) => [
      row.sourceId,
      sourceUuid(model.businessId, "staff", row.sourceId),
    ]),
  );
  const columns = new Set(observation.staffResources);
  if (
    observation.filter === "all" &&
    (columns.size !== staff.size || [...columns].some((resource) => !staff.has(resource)))
  )
    throw new Error("The visible columns do not cover the snapshot team");
  if (
    !observation.cards.length &&
    (observation.filter !== "all" || !columns.size || observation.staffBlocks === undefined)
  )
    throw new Error("An empty calendar observation requires verified columns and a block count");
  const seen = new Set<string>();
  const acceptCard = (card: z.infer<typeof cardIdentitySchema>) => {
    const itemRef = card.itemElementId.slice(3);
    if (seen.has(itemRef)) throw new Error("Observed calendar contains duplicate card identities");
    if (columns.size > 0 && !columns.has(card.columnResource))
      throw new Error("An observed card belongs to an unverified column");
    seen.add(itemRef);
    return itemRef;
  };
  const readInterval = ({ interval }: z.infer<typeof cardSchema>) => {
    const [start, end] = interval.split(/\s*-\s*/);
    const endDate = end! < start! ? date.add({ days: 1 }) : date;
    return {
      start: Date.parse(sourceInstant(`${date}T${start}`)),
      end: Date.parse(sourceInstant(`${endDate}T${end}`)),
    };
  };
  const observedOnly = [];
  const differences = [];
  for (const card of observation.cards) {
    const itemRef = acceptCard(card);
    const archived = items.get(itemRef);
    if (!archived) {
      observedOnly.push({ itemRef, ...card });
      continue;
    }
    const { start, end } = readInterval(card);
    const fields = [
      ...(archived.sourceCopy!.groupRef === card.appointmentAttribute ? [] : ["reservation"]),
      ...(archived.staffId === staff.get(card.columnResource) ? [] : ["professional"]),
      ...(Date.parse(archived.startsAt) === start ? [] : ["start"]),
      ...(Date.parse(archived.endsAt) === end ? [] : ["end"]),
    ];
    if (fields.length) differences.push({ itemRef, fields });
    items.delete(itemRef);
  }
  const cardsWithoutVisibleTimes = (observation.cardsWithoutVisibleTimes ?? []).map((card) => {
    const itemRef = acceptCard(card);
    const archived = items.delete(itemRef);
    return { itemRef, archived, ...card };
  });
  let staffBlocks:
    | {
        matches: number;
        observedOnly: NonNullable<typeof observation.staffBlocks>;
        archivedNotVisible: string[];
      }
    | undefined;
  if (observation.staffBlocks) {
    const expected = model.base.timeOff.filter(
      (block) => Date.parse(block.startsAt) < to && Date.parse(block.endsAt) > from,
    );
    const observedOnly = [];
    for (const card of observation.staffBlocks) {
      acceptCard(card);
      const { start, end } = readInterval(card);
      const match = expected.findIndex(
        (block) =>
          block.staffRef === card.columnResource &&
          Date.parse(block.startsAt) === start &&
          Date.parse(block.endsAt) === end,
      );
      if (match < 0) observedOnly.push(card);
      else expected.splice(match, 1);
    }
    staffBlocks = {
      matches: observation.staffBlocks.length - observedOnly.length,
      observedOnly,
      archivedNotVisible: expected.map((block) => block.sourceId),
    };
  }
  return {
    date: observation.date,
    capturedAt: observation.capturedAt,
    filter: observation.filter,
    ...(observation.staffResources ? { staffColumnsObserved: columns.size } : {}),
    cardsChecked: observation.cards.length,
    matches: observation.cards.length - observedOnly.length - differences.length,
    observedOnly,
    differences,
    cardsWithoutVisibleTimes,
    ...(staffBlocks ? { staffBlocks } : {}),
    archivedNotVisible: [...items.values()].map((row) => row.sourceCopy?.itemRef ?? row.id),
    canCutOver: false,
  };
}

if (import.meta.main) {
  try {
    const [snapshotFile, calendarFile, ...extra] = process.argv.slice(2);
    if (!snapshotFile || !calendarFile || extra.length)
      throw new Error(
        "Usage: booksy-reconcile-calendar.ts <source-snapshot> <private-calendar-observation>",
      );
    const [{ hash: expected, model }, { directory: output, bytes }] = await Promise.all([
      readPrivateBooksySnapshot(snapshotFile),
      readPrivateArchiveFile(calendarFile),
    ]);
    const observationSha256 = createHash("sha256").update(bytes).digest("hex");
    const result = reconcileObservedCalendar(model, JSON.parse(bytes.toString("utf8")));
    const receipt = { snapshotHash: expected, observationSha256, ...result };
    await privateWriteVerified(
      resolve(output, `calendar-reconciliation-${fingerprint(receipt)}.json`),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      JSON.stringify({
        date: result.date,
        matches: result.matches,
        observedOnly: result.observedOnly.length,
        changed: result.differences.length,
        missingVisibleTimes: result.cardsWithoutVisibleTimes.length,
        archivedNotVisible: result.archivedNotVisible.length,
        ...(result.staffBlocks
          ? {
              staffBlocks: result.staffBlocks.matches,
              blocksObservedOnly: result.staffBlocks.observedOnly.length,
              blocksArchivedNotVisible: result.staffBlocks.archivedNotVisible.length,
            }
          : {}),
        canCutOver: false,
      }),
    );
  } catch {
    console.error(
      "Calendar reconciliation failed. Check the observation and the immutable source snapshot.",
    );
    process.exitCode = 1;
  }
}
