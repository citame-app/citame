import { expect, test } from "bun:test";
import { toCsv } from "./csv";

test("CSV quotes delimiters and prevents spreadsheet formulas in client-controlled text", () => {
  expect(
    toCsv([
      ["name", "cents"],
      ['=HYPERLINK("bad")', 100],
      ["a,b\nnext", -100],
    ]),
  ).toBe('"name","cents"\r\n"\'=HYPERLINK(""bad"")","100"\r\n"a,b\nnext","-100"');
  expect(toCsv([["\t=1+1", "  +SUM(A1)", "@command", "plain"]])).toContain("'@command");
});
