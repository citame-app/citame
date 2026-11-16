export class CreativeOverflowError extends Error {}
type Measure = (value: string, size: number) => number;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function wrapCreativeText(
  value: string,
  width: number,
  size: number,
  measure: Measure,
): string[] {
  if (!value) return [];
  const lines: string[] = [];
  for (const paragraph of value.replaceAll("\r\n", "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const { segment } of graphemes.segment(word)) {
        if (line && measure(line + segment, size) > width) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}
export function fitCreativeText(
  value: string,
  width: number,
  height: number,
  options: { min: number; max: number; lineHeight: number },
  measure: Measure,
) {
  if (width <= 0 || height < 0 || options.min <= 0)
    throw new CreativeOverflowError("Invalid text area");
  for (let size = options.max; size >= options.min; size--) {
    const lines = wrapCreativeText(value, width, size, measure);
    const lineHeight = size * options.lineHeight;
    if (lines.length * lineHeight <= height && lines.every((line) => measure(line, size) <= width))
      return { lines, fontSize: size, lineHeight, height: lines.length * lineHeight };
  }
  throw new CreativeOverflowError("Content cannot fit without clipping or unreadable text");
}
