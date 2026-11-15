export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let cell = value === null ? "" : String(value);
          if (typeof value === "string" && /^\s*[=+@-]/.test(cell)) cell = `'${cell}`;
          return `"${cell.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
export function downloadCsv(rows: (string | number | null)[][], filename: string) {
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", toCsv(rows)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
