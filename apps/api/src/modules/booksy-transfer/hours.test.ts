import { expect, test } from "bun:test";
import { parseBooksyDayHours } from "./hours";

test("preserves split work periods and subtracts every explicitly listed break", () => {
  expect(parseBooksyDayHours(["09:30 - 18:30", "9h", "Descanso", "13:45 - 14:45", "1h"])).toEqual([
    { start: "09:30", end: "13:45" },
    { start: "14:45", end: "18:30" },
  ]);
  expect(parseBooksyDayHours(["09:00 - 13:00", "4h", "15:00 - 20:00", "5h"])).toEqual([
    { start: "09:00", end: "13:00" },
    { start: "15:00", end: "20:00" },
  ]);
  expect(parseBooksyDayHours(["Inactivo", "-"])).toEqual([]);
});
test("unknown schedule text, invalid times and breaks outside work are quarantined", () => {
  expect(parseBooksyDayHours(["Horario variable"])).toBeNull();
  expect(parseBooksyDayHours(["09:00 - 25:00"])).toBeNull();
  expect(parseBooksyDayHours(["09:00 - 13:00", "Descanso", "14:00 - 15:00"])).toBeNull();
});
