/** Read-only parser for the observed Spanish weekly schedule. Breaks are subtracted, never ignored. */
export function parseBooksyDayHours(lines: string[]): { start: string; end: string }[] | null {
  const minute = (value: string) => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const format = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  if (lines[0] === "Inactivo") return [];
  const work: { start: number; end: number }[] = [];
  const breaks: { start: number; end: number }[] = [];
  let nextBreak = false;
  for (const line of lines) {
    if (
      !line ||
      line === "-" ||
      /^(?:(\d+)h\s*)?(?:(\d+)min)?$/.test(line) ||
      line.startsWith("IR A ")
    )
      continue;
    if (line === "Descanso") {
      nextBreak = true;
      continue;
    }
    const match = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(line);
    if (!match) return null;
    const start = minute(match[1]!),
      end = minute(match[2]!);
    if (start === null || end === null || end <= start) return null;
    (nextBreak ? breaks : work).push({ start, end });
    nextBreak = false;
  }
  if (nextBreak || !work.length) return null;
  let windows = work.sort((a, b) => a.start - b.start);
  if (windows.some((w, i) => i > 0 && w.start < windows[i - 1]!.end)) return null;
  for (const pause of breaks.sort((a, b) => a.start - b.start)) {
    const own = windows.find((w) => w.start <= pause.start && w.end >= pause.end);
    if (!own) return null;
    windows = windows.flatMap((w) =>
      w !== own
        ? [w]
        : [
            ...(w.start < pause.start ? [{ start: w.start, end: pause.start }] : []),
            ...(pause.end < w.end ? [{ start: pause.end, end: w.end }] : []),
          ],
    );
  }
  return windows.map((w) => ({ start: format(w.start), end: format(w.end) }));
}
