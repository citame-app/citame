import { expect, test } from "bun:test";
import { bookingEntryUrl, bookingWidgetSnippet } from "./links";

const first = "0198f5a0-7b1c-7000-8000-000000000001";
const second = "0198f5a0-7b1c-7000-8000-000000000002";
test("booking links preserve a bounded reviewed selection and use the current deployment's origin only", () => {
  const link = new URL(
    bookingEntryUrl("https://booking.example/", { serviceIds: [first, second], staffId: second }),
  );
  expect(link.origin).toBe("https://booking.example");
  expect(link.pathname).toBe("/book");
  expect(link.searchParams.get("services")).toBe(`${first},${second}`);
  expect(link.searchParams.get("staff")).toBe(second);
  expect(bookingEntryUrl("http://localhost:4273", { serviceIds: [] })).toBe(
    "http://localhost:4273/book",
  );
  for (const origin of [
    "javascript:alert(1)",
    "https://person:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=private",
    "https://example.com/#x",
  ])
    expect(() => bookingEntryUrl(origin, { serviceIds: [] })).toThrow();
  expect(() => bookingEntryUrl("https://example.com", { serviceIds: [first, first] })).toThrow();
  expect(() => bookingEntryUrl("https://example.com", { serviceIds: ["invalid"] })).toThrow();
});
test("widget snippets escape salon text and query attributes and open no sign-in flow themselves", () => {
  const snippet = bookingWidgetSnippet(
    "https://booking.example",
    { serviceIds: [first], staffId: second },
    'Salon "<test>" & team',
  );
  expect(snippet).toContain("/widget?services=");
  expect(snippet).toContain("&amp;staff=");
  expect(snippet).toContain("Salon &quot;&lt;test&gt;&quot; &amp; team");
  expect(snippet).not.toContain("<test>");
  expect(snippet).not.toContain("<script");
  expect(snippet).toContain('loading="lazy"');
});
