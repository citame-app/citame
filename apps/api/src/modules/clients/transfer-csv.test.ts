import { expect, test } from "bun:test";
import { readClientCsv, writeClientCsv } from "./transfer-csv";

test("client CSV accepts BOM, reordered columns, quoted commas/newlines and doubled quotes", () => {
  const rows = readClientCsv(
    '\uFEFFphone,name,notes,email,tags\r\n+34600111222,"Nora, Peña","First line\nSaid ""hello""",NORA@example.com,vip;colour\r\n',
  );
  expect(rows).toEqual([
    {
      row: 2,
      name: "Nora, Peña",
      phone: "+34600111222",
      email: "NORA@example.com",
      notes: 'First line\nSaid "hello"',
      tags: "vip;colour",
    },
  ]);
});

test("CSV exports are spreadsheet-safe and round-trip the original text including apostrophes", () => {
  const original = {
    row: 2,
    name: '=HYPERLINK("untrusted")',
    phone: "+34600111222",
    email: "nora@example.com",
    notes: "'@original\nnext",
    tags: "vip",
  };
  const csv = writeClientCsv([original]);
  expect(csv).toContain("'+34600111222");
  expect(csv).toContain("'=HYPERLINK");
  expect(readClientCsv(csv)).toEqual([original]);
});

test("malformed syntax and unsupported headers fail before a preview can be accepted", () => {
  for (const csv of [
    'name,phone\n"Nora,+34600111222',
    "name,name\nNora,Nora",
    "name,marketing_consent\nNora,true",
    "name,phone\nNora,+34600111222,extra",
    'name,phone\nNo"ra,+34600111222',
  ])
    expect(() => readClientCsv(csv)).toThrow();
  expect(() => readClientCsv("phone\n+34600111222")).toThrow();
});

test("CSV parsing is bounded and never silently drops excess records", () => {
  expect(() =>
    readClientCsv(
      `name,phone\n${Array.from({ length: 501 }, (_, i) => `Client ${i},+34600${String(i).padStart(6, "0")}`).join("\n")}`,
    ),
  ).toThrow();
  expect(() => readClientCsv(`name,notes\nNora,${"á".repeat(400000)}`)).toThrow();
});
