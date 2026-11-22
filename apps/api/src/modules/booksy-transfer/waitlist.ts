import { createHash } from "node:crypto";
import type { Database, waitlistSourceEntry } from "@sob/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { fingerprint, sourceUuid } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

const response = z.object({
  source: z.url(),
  businessId: z.string(),
  capturedAt: z.iso.datetime({ offset: true }),
  data: z.object({ body: z.string(), data: z.unknown() }),
});
const rows = z
  .object({
    results: z.array(
      z.object({
        id: z.number().int().positive(),
        customer: z.object({ id: z.number().int().positive() }),
        date: z.iso.date(),
        flexible: z.boolean(),
        order: z.number().int().nonnegative(),
        slot_duration: z.string().regex(/^[1-9]\d{0,3} mins slot$/),
      }),
    ),
  })
  .strict();
const dateRange = z.object({ start: z.iso.date(), end: z.iso.date() });
const archiveBatchBytes = 8 * 1024 * 1024;

/** Read observations from verified original bytes. The JSONB copy is a derived index. */
export async function planBooksyWaitlist(
  db: Pick<Database, "execute">,
  model: Pick<BooksySourceReadModel, "businessId" | "fromDate" | "throughDate" | "base">,
) {
  const artifacts = model.base.artifacts;
  if (new Set(artifacts.map(({ sha256 }) => sha256)).size !== artifacts.length)
    throw new Error("The reviewed archive repeats an artifact");
  const observations: { sha256: string; payload: Uint8Array }[] = [];
  let batch = new Map<string, number>();
  let batchBytes = 0;
  const readBatch = async () => {
    const captured = await db.execute<{ sha256: string; payload: Uint8Array }>(
      sql`select sha256,payload from booksy_rehearsal.raw_capture
        where business_id=${model.businessId}
        and sha256 in (select jsonb_array_elements_text(${JSON.stringify([...batch.keys()])}::text::jsonb))`,
    );
    if (captured.length !== batch.size)
      throw new Error("The reviewed archive is incomplete or has changed");
    for (const { sha256, payload } of captured) {
      if (
        payload.byteLength !== batch.get(sha256) ||
        createHash("sha256").update(payload).digest("hex") !== sha256
      )
        throw new Error("The reviewed archive is incomplete or has changed");
      const original: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
      if (
        original &&
        typeof original === "object" &&
        "source" in original &&
        typeof original.source === "string" &&
        original.source.includes("/waitlist/")
      )
        observations.push({ sha256, payload });
    }
  };
  for (const { sha256, bytes } of artifacts) {
    if (batch.size && (batchBytes + bytes > archiveBatchBytes || batch.size === 128)) {
      await readBatch();
      batch = new Map();
      batchBytes = 0;
    }
    batch.set(sha256, bytes);
    batchBytes += bytes;
  }
  if (batch.size) await readBatch();
  return projectBooksyWaitlist(observations, model);
}

export function projectBooksyWaitlist(
  captured: { sha256: string; payload: Uint8Array }[],
  model: Pick<BooksySourceReadModel, "businessId" | "fromDate" | "throughDate" | "base">,
) {
  type Source = {
    capturedAt: Temporal.Instant;
    hash: string;
    items: z.output<typeof rows>["results"];
  };
  const byDate = new Map<string, Source>();
  const lastSeen = new Map<number, { date: string; capturedAt: Temporal.Instant }>();
  const observations = captured.flatMap(({ sha256, payload }) => {
    const bytes = Buffer.from(payload);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("Waitlist archive checksum differs");
    const capture = response.parse(JSON.parse(bytes.toString("utf8")));
    const url = new URL(capture.source);
    if (
      capture.businessId !== model.businessId ||
      url.origin !== "https://es.booksy.com" ||
      url.pathname !== `/core/v2/business_api/me/businesses/${model.businessId}/waitlist/`
    )
      throw new Error("Unexpected waitlist source");
    const query = url.searchParams;
    // A filtered or paginated result cannot replace the complete list for a day.
    if (
      [...query.keys()].some((key) => key !== "start" && key !== "end") ||
      query.getAll("start").length > 1 ||
      query.getAll("end").length > 1
    )
      return [];
    const { start, end } = dateRange.parse({ start: query.get("start"), end: query.get("end") });
    const day = Temporal.PlainDate.from(start);
    const span = day.until(Temporal.PlainDate.from(end)).days;
    if (span < 0 || span > 30) throw new Error("Unexpected waitlist observation range");
    const body = JSON.parse(capture.data.body);
    if (fingerprint(body) !== fingerprint(capture.data.data))
      throw new Error("Waitlist source response differs from retained data");
    const data = rows.parse(body);
    if (new Set(data.results.map((row) => row.id)).size !== data.results.length)
      throw new Error("Duplicate waitlist references in one observation");
    if (data.results.some((r) => r.date < start || r.date > end))
      throw new Error("Waitlist entry falls outside the observed date range");
    return [
      {
        day,
        span,
        source: {
          capturedAt: Temporal.Instant.from(capture.capturedAt),
          hash: sha256,
          items: data.results,
        },
      },
    ];
  });
  observations.sort(
    (a, b) =>
      Temporal.Instant.compare(b.source.capturedAt, a.source.capturedAt) ||
      a.source.hash.localeCompare(b.source.hash),
  );
  for (const { day, span, source } of observations) {
    for (const row of source.items) {
      const previous = lastSeen.get(row.id);
      if (!previous) {
        lastSeen.set(row.id, { date: row.date, capturedAt: source.capturedAt });
      } else if (previous.capturedAt.equals(source.capturedAt) && previous.date !== row.date) {
        throw new Error("Waitlist reference has conflicting requested dates");
      }
    }
    for (let offset = 0; offset <= span; offset++) {
      const date = day.add({ days: offset }).toString();
      if (date < model.fromDate || date > model.throughDate) continue;
      const items = source.items.filter((r) => r.date === date).sort((a, b) => a.id - b.id);
      const previous = byDate.get(date);
      if (previous) {
        if (
          previous.capturedAt.equals(source.capturedAt) &&
          fingerprint(previous.items) !== fingerprint(items)
        )
          throw new Error("Simultaneous waitlist observations disagree");
        continue;
      }
      byDate.set(date, { ...source, items });
    }
  }
  const clients = new Set(model.base.clients.map((client) => client.sourceId));
  const entries: (typeof waitlistSourceEntry.$inferInsert)[] = [];
  for (const [, source] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    for (const row of source.items) {
      // A request moved to another date stays there even if a later capture
      // no longer contains it. The previous date must not resurrect it.
      if (lastSeen.get(row.id)?.date !== row.date) continue;
      const clientRef = String(row.customer.id);
      if (!clients.has(clientRef)) throw new Error("Unmapped waitlist client");
      entries.push({
        id: sourceUuid(model.businessId, "waitlist", String(row.id)),
        clientId: sourceUuid(model.businessId, "clients", clientRef),
        requestedDate: row.date,
        durationMinutes: Number.parseInt(row.slot_duration, 10),
        flexible: row.flexible,
        sourceOrder: row.order,
        sourceHash: source.hash,
        capturedAt: new Date(source.capturedAt.epochMilliseconds),
      });
    }
  }
  return {
    entries,
    observedDates: byDate.size,
    ignoredObservations: captured.length - observations.length,
    observedAtByDate: new Map([...byDate].map(([date, source]) => [date, source.capturedAt])),
  };
}

export type BooksyWaitlistProjection = ReturnType<typeof projectBooksyWaitlist>;
