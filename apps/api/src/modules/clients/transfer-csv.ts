import { CLIENT_CSV_MAX_BYTES, CLIENT_IMPORT_MAX_ROWS } from "@sob/contracts";
import { DomainError } from "../../errors";

const columns = ["name", "email", "phone", "notes", "tags"] as const;
type Column = (typeof columns)[number];
export type ClientCsvRow = Record<Column, string> & { row: number };
const fail = (message: string): never => {
  throw new DomainError("validation_error", message);
};

/** Strict quoted CSV; bounded before parsing, with no heuristic delimiter/header guessing. */
export function readClientCsv(input: string): ClientCsvRow[] {
  if (new TextEncoder().encode(input).length > CLIENT_CSV_MAX_BYTES)
    fail("CSV exceeds the 400 KB limit");
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const finishCell = () => {
    cells.push(cell);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (cells.some((value) => value.trim() !== "")) records.push(cells);
    cells = [];
    if (records.length > CLIENT_IMPORT_MAX_ROWS + 1) fail("CSV exceeds the 500 client limit");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") finishCell();
    else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (char === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || char === '"') fail("Malformed CSV quoting");
      cell += char;
    }
    if (cell.length > 10000 || cells.length > columns.length + 1)
      fail("CSV field exceeds the supported limits");
  }
  if (quoted) fail("Unclosed CSV quote");
  if (cell !== "" || cells.length || closed) finishRow();
  const headers = records.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  if (
    !headers.includes("name") ||
    new Set(headers).size !== headers.length ||
    headers.some((key) => ![...columns, "escaped_fields"].includes(key as Column))
  )
    fail(
      "CSV requires a unique name header and supports only name, email, phone, notes, tags and escaped_fields",
    );
  if (!records.length) fail("CSV has no client rows");
  return records.map((record, index) => {
    if (record.length !== headers.length)
      fail(`CSV record ${index + 2} has a different number of columns`);
    const values = Object.fromEntries(headers.map((header, i) => [header, record[i] ?? ""]));
    const escaped = values.escaped_fields ? values.escaped_fields.split(";") : [];
    if (
      new Set(escaped).size !== escaped.length ||
      escaped.some((key) => !columns.includes(key as Column) || !values[key]?.startsWith("'"))
    )
      fail("Invalid spreadsheet escape metadata");
    for (const key of escaped) values[key] = (values[key] ?? "").slice(1);
    return {
      row: index + 2,
      ...Object.fromEntries(columns.map((key) => [key, values[key] ?? ""])),
    } as ClientCsvRow;
  });
}

/** The extra escape column makes spreadsheet protection reversible on a later import. */
export function writeClientCsv(rows: ReadonlyArray<Omit<ClientCsvRow, "row">>): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const records = rows.map((row) => {
    const escaped: string[] = [];
    const cells = columns.map((key) => {
      const value = row[key];
      if (/^(?:\s*[=+@-]|[\t\r\n])/.test(value)) {
        escaped.push(key);
        return `'${value}`;
      }
      return value;
    });
    return [...cells, escaped.join(";")];
  });
  return `\uFEFF${[[...columns, "escaped_fields"], ...records].map((row) => row.map(quote).join(",")).join("\r\n")}`;
}
