import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { fingerprint, planBooksyTransfer } from "../modules/booksy-transfer/plan";
import {
  type BooksySourceReadModel,
  sourceInstant,
} from "../modules/booksy-transfer/source-read-model";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { privateWriteVerified, verifyArtifacts } from "../modules/booksy-transfer/vault";

const observedCard = z.object({
  itemElementId: z.string().regex(/^cc-\d+$/),
  appointmentAttribute: z.string().regex(/^\d+$/),
  columnResource: z.string().regex(/^\d+$/),
  interval: z.string().regex(/^\d{2}:\d{2} - \d{2}:\d{2}$/),
});
const detailSchema = z.object({
  date: z.iso.date(),
  source: z.literal("booksy_visible_difference_details"),
  observed: z.object({ block: observedCard }),
  staffBlock: z.object({
    drawer: z.string(),
    fields: z.array(z.object({ placeholder: z.string(), value: z.string() })).length(6),
  }),
});
const calendarSchema = z.object({
  date: z.iso.date(),
  capturedAt: z.iso.datetime(),
  source: z.literal("booksy_visible_calendar"),
  filter: z.literal("all"),
  timezone: z.literal("Europe/Madrid"),
  staffResources: z.array(z.string()),
  staffBlocks: z.array(observedCard),
});

export function appendVisibleStaffBlock(
  model: BooksySourceReadModel,
  calendarInput: unknown,
  detailInput: unknown,
  evidence: BooksySourceReadModel["base"]["artifacts"][number],
) {
  const calendar = calendarSchema.parse(calendarInput);
  const detail = detailSchema.parse(detailInput);
  const sourceCard = detail.observed.block;
  const staff = model.base.staff.find((row) => row.sourceId === sourceCard.columnResource);
  const columns = new Set(calendar.staffResources);
  if (
    detail.date !== calendar.date ||
    detail.date < model.fromDate ||
    detail.date > model.throughDate ||
    !staff ||
    columns.size !== model.base.staff.length ||
    model.base.staff.some((row) => !columns.has(row.sourceId)) ||
    calendar.staffBlocks.filter((card) => fingerprint(card) === fingerprint(sourceCard)).length !==
      1
  )
    throw new Error("The visible block and full calendar observation do not agree");

  const fields = new Map(
    detail.staffBlock.fields.map(({ placeholder, value }) => [placeholder, value.trim()]),
  );
  const [start, end] = sourceCard.interval.split(" - ");
  const label = Temporal.PlainDate.from(detail.date).toLocaleString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const normalizeDate = (value: string) => value.replaceAll(".", "").toLocaleLowerCase("es-ES");
  const reason = fields.get("Motivo");
  if (
    fields.size !== 6 ||
    normalizeDate(fields.get("Fecha") ?? "") !== normalizeDate(label) ||
    fields.get("Inicio") !== start ||
    fields.get("Fin") !== end ||
    fields.get("Empleado") !== staff.name.trim() ||
    fields.get("Recurso") !== "Ningún recurso" ||
    !reason ||
    !/falta de disponibilidad|tiempo no disponible/i.test(detail.staffBlock.drawer)
  )
    throw new Error("Only one explicitly assigned staff interval can be projected");

  const startsAt = sourceInstant(`${detail.date}T${start}`);
  const endsAt = sourceInstant(`${detail.date}T${end}`);
  const sourceId = sourceCard.itemElementId.slice(3);
  if (
    Date.parse(endsAt) <= Date.parse(startsAt) ||
    model.base.timeOff.some(
      (row) =>
        row.sourceId === sourceId ||
        (row.staffRef === staff.sourceId && row.startsAt === startsAt && row.endsAt === endsAt),
    )
  )
    throw new Error("The staff interval is invalid or already archived");
  return {
    ...model,
    base: {
      ...model.base,
      artifacts: [...model.base.artifacts, evidence],
      timeOff: [
        ...model.base.timeOff,
        {
          sourceId,
          staffRef: staff.sourceId,
          startsAt,
          endsAt,
          reason,
          raw: { kind: "booksy-reviewed-visible-block", evidenceSha256: evidence.sha256 },
        },
      ],
    },
    summary: { ...model.summary, blocks: model.summary.blocks + 1 },
  } satisfies BooksySourceReadModel;
}

if (import.meta.main) {
  try {
    const [snapshotName, manifestName, calendarName, detailName, ...extra] = process.argv.slice(2);
    if (!snapshotName || !manifestName || !calendarName || !detailName || extra.length)
      throw new Error("Expected the snapshot, manifest, day observation and block detail");
    const snapshot = await realpath(snapshotName);
    const root = dirname(snapshot);
    const info = await stat(root);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Expected an operator-owned private archive");
    const model = JSON.parse(await readFile(snapshot, "utf8")) as BooksySourceReadModel;
    const parentHash = fingerprint(model);
    if (basename(snapshot) !== `source-snapshot-${parentHash}.json`)
      throw new Error("Source snapshot hash differs");
    const manifest = JSON.parse(await readFile(manifestName, "utf8")) as BooksyArchiveManifest;
    if (
      manifest.businessId !== model.businessId ||
      manifest.timezone !== model.base.timezone ||
      manifest.fromDate !== model.fromDate ||
      fingerprint(
        manifest.artifacts.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      ) !== fingerprint(model.base.artifacts)
    )
      throw new Error("The manifest does not cover this snapshot");
    await verifyArtifacts(root, model.base);
    const [calendar, detail] = await Promise.all(
      [calendarName, detailName].map(async (file) => {
        const path = await realpath(file);
        if (dirname(path) !== join(root, "ui-reconciliation") || (await stat(path)).mode & 0o077)
          throw new Error("The evidence must be kept in the private reconciliation directory");
        const bytes = await readFile(path);
        return { name: basename(path), bytes };
      }),
    );
    const kind = "booksy-reviewed-visible-block";
    const envelope = JSON.stringify(
      {
        kind,
        businessId: model.businessId,
        parentHash,
        originals: [calendar!, detail!].map(({ name, bytes }) => ({
          name,
          base64: bytes.toString("base64"),
        })),
      },
      null,
      2,
    );
    const sha256 = createHash("sha256").update(envelope).digest("hex");
    const artifact = {
      path: `visible-block-${sha256}.json`,
      sha256,
      bytes: Buffer.byteLength(envelope),
    };
    const next = appendVisibleStaffBlock(
      model,
      JSON.parse(calendar!.bytes.toString()),
      JSON.parse(detail!.bytes.toString()),
      artifact,
    );
    const { review } = planBooksyTransfer(next.base);
    if (!review.canRehearse) throw new Error("The amended snapshot could not be rehearsed");
    const nextManifest = {
      ...manifest,
      artifacts: [...manifest.artifacts, { ...artifact, kind }],
      complete: false,
    };
    const hash = fingerprint(next);
    const snapshotPath = join(root, `source-snapshot-${hash}.json`);
    const bundlePath = join(root, `bundle-${fingerprint(next.base)}.json`);
    const manifestPath = join(root, `manifest-${fingerprint(nextManifest)}.json`);
    await privateWriteVerified(join(root, artifact.path), envelope);
    await privateWriteVerified(snapshotPath, JSON.stringify(next, null, 2));
    await privateWriteVerified(bundlePath, JSON.stringify(next.base, null, 2));
    await privateWriteVerified(manifestPath, JSON.stringify(nextManifest, null, 2));
    console.log(
      JSON.stringify({
        hash,
        snapshotPath,
        bundlePath,
        manifestPath,
        reviewHash: review.reviewHash,
        staffBlocks: next.summary.blocks,
      }),
    );
  } catch {
    console.error("Visible block preparation failed. Verify the private archive and observations.");
    process.exitCode = 1;
  }
}
