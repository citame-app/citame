import { expect, test } from "bun:test";
import { packBooksyJson, unpackBooksyJson } from "./jsonb-codec";

test("retains NUL, unpaired UTF-16, literal escapes and reserved markers without changing source values", () => {
  for (const original of [
    { note: "safe", nested: [1, true, null] },
    { sort: ["a\u0000b", "\ud800", "\\u0000"] },
    { __booksyEncoding: "citame-booksy-json-utf8-base64-v1", base64: "e30=" },
  ])
    expect(unpackBooksyJson(packBooksyJson(original))).toEqual(original);
  expect(packBooksyJson({ ordinary: "text" })).toEqual({ ordinary: "text" });
});
