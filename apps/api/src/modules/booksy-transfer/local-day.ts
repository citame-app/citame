import { z } from "zod";

export function booksyLocalDayBounds(date: string, timezone: string) {
  const day = Temporal.PlainDate.from(z.iso.date().parse(date));
  return {
    start: day.toZonedDateTime(timezone).epochMilliseconds,
    end: day.add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
  };
}
