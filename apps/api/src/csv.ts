import type { Database } from "@sob/db";
import type { Tx } from "./tx";

type Cell = string | number | boolean | null;

const csvRow = (values: Cell[]) =>
  `${values
    .map((value) => {
      const text = value === null ? "" : String(value);
      const guarded = typeof value === "string" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text);
      return `"${guarded ? "'" : ""}${text.replaceAll('"', '""')}"`;
    })
    .join(",")}\r\n`;

/** Stream ordered batches from one read-only snapshot with backpressure. */
export function streamCsv<Row>(
  db: Database,
  options: {
    filename: string;
    headOnly: boolean;
    columns: string[];
    readBatch: (tx: Tx, cursor: NoInfer<Row> | undefined, limit: number) => Promise<Row[]>;
    cells: (row: Row) => Cell[];
  },
) {
  const headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${options.filename}"`,
    "Cache-Control": "private, no-store",
  };
  if (options.headOnly) return new Response(null, { headers });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = async (text: string) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        writer.write(encoder.encode(text)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("CSV download stalled")), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  void db
    .transaction(
      async (tx) => {
        await write(`\uFEFF${csvRow(options.columns)}`);
        let cursor: Row | undefined;
        for (;;) {
          const rows = await options.readBatch(tx, cursor, 500);
          if (!rows.length) break;
          await write(rows.map((row) => csvRow(options.cells(row))).join(""));
          cursor = rows.at(-1);
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    )
    .then(() => writer.close())
    .catch(() => writer.abort(new Error("CSV export interrupted")).catch(() => {}));

  return new Response(readable, { headers });
}
