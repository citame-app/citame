import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compareBooksyWaitlists } from "./delta";
import { transferFixture } from "./fixtures";
import { sourceUuid } from "./plan";
import { projectBooksyWaitlist } from "./waitlist";

const base = transferFixture();
const businessId = base.businessId;
const source = {
  businessId,
  fromDate: "2026-11-18",
  throughDate: "2026-11-20",
  base: { ...base, clients: [{ ...base.clients[0]!, sourceId: "42" }] },
};
const row = {
  id: 1,
  customer: { id: 42 },
  date: "2026-11-18",
  flexible: false,
  order: 1,
  slot_duration: "90 mins slot",
};
function capture(
  capturedAt: string,
  results: (typeof row)[],
  day = "2026-11-18",
  query = `start=${day}&end=${day}`,
) {
  const data = { results };
  const payload = Buffer.from(
    JSON.stringify({
      source: `https://es.booksy.com/core/v2/business_api/me/businesses/${businessId}/waitlist/?${query}`,
      businessId,
      capturedAt,
      data: { data, body: JSON.stringify(data) },
    }),
  );
  return { payload, sha256: createHash("sha256").update(payload).digest("hex") };
}

test("archived waitlist projection uses the latest observation and retains only known preferences", () => {
  const early = capture("2026-11-17T11:00:00Z", [row]);
  const later = capture("2026-11-17T17:00:00Z", [row, { ...row, id: 2, order: 2 }]);
  const plan = projectBooksyWaitlist([later, early], source);
  expect(plan.observedDates).toBe(1);
  expect(plan.entries).toHaveLength(2);
  expect(plan.entries[0]).toMatchObject({
    durationMinutes: 90,
    flexible: false,
    sourceHash: later.sha256,
  });
  expect(plan.entries[0]).not.toHaveProperty("serviceIds");
  const removed = capture("2026-11-17T18:00:00Z", []);
  expect(projectBooksyWaitlist([early, later, removed], source).entries).toHaveLength(0);
  expect(() => projectBooksyWaitlist([{ ...later, sha256: "invalid" }], source)).toThrow(
    "checksum",
  );
});

test("filtered or ambiguous waitlist observations never replace a complete capture", () => {
  const original = capture("2026-11-17T11:00:00Z", [row]);
  const date = row.date;
  const range = `start=${date}&end=${date}`;
  const extras = ["staffer_id=10", "page=2", `start=${date}`, "end=2026-11-20"];
  const partial = extras.map((suffix, index) =>
    capture(`2026-11-17T1${index + 2}:00:00Z`, [], date, `${range}&${suffix}`),
  );
  const destination = "2026-11-19";
  const filteredMove = capture(
    "2026-11-17T16:00:00Z",
    [{ ...row, date: destination }],
    destination,
    `start=${destination}&end=${destination}&staffer_id=10`,
  );
  const before = projectBooksyWaitlist([original], source);
  const after = projectBooksyWaitlist([filteredMove, ...partial, original], source);
  expect(after).toMatchObject({
    entries: before.entries,
    observedDates: 1,
    ignoredObservations: 5,
  });
  expect(compareBooksyWaitlists(before, projectBooksyWaitlist(partial, source))).toMatchObject({
    absentOnReobservedDate: [],
    absenceUnverified: [sourceUuid(businessId, "waitlist", String(row.id))],
    currentObservedDates: 0,
    currentIgnoredObservations: 4,
  });
});

test("a later date change wins regardless of the order in which dates were first observed", () => {
  const early = capture("2026-11-17T12:00:00Z", []);
  const original = capture("2026-11-17T13:00:00Z", [{ ...row, date: "2026-11-19" }], "2026-11-19");
  const changed = capture("2026-11-17T14:00:00Z", [row]);
  for (const observations of [
    [early, original, changed],
    [original, early, changed],
  ]) {
    expect(projectBooksyWaitlist(observations, source).entries).toMatchObject([
      { requestedDate: "2026-11-18" },
    ]);
  }
});

test("a request removed after moving cannot return on the old date", () => {
  const original = capture("2026-11-17T13:00:00Z", [row]);
  const moved = capture("2026-11-17T13:00:00.001Z", [{ ...row, date: "2026-11-19" }], "2026-11-19");
  const removed = capture("2026-11-17T14:00:00Z", [], "2026-11-19");
  for (const observations of [
    [original, moved, removed],
    [removed, moved, original],
  ]) {
    expect(projectBooksyWaitlist(observations, source)).toMatchObject({
      entries: [],
      observedDates: 2,
    });
  }
});

test("the delta distinguishes later empty observations from dates without new evidence", () => {
  const t0 = "2026-11-17T13:00:00Z";
  const t1 = "2026-11-17T14:00:00Z";
  const unchangedDay = "2026-11-19";
  const updatedDay = "2026-11-20";
  const third = { ...row, id: 3, date: updatedDay };
  const before = projectBooksyWaitlist(
    [
      capture(t0, [row]),
      capture(t0, [{ ...row, id: 2, date: unchangedDay }], unchangedDay),
      capture(t0, [third], updatedDay),
    ],
    source,
  );
  const after = projectBooksyWaitlist(
    [
      capture(t1, []),
      capture(
        t1,
        [
          { ...third, slot_duration: "60 mins slot", order: 2 },
          { ...third, id: 4 },
        ],
        updatedDay,
      ),
    ],
    source,
  );
  const id = (ref: string) => sourceUuid(businessId, "waitlist", ref);
  expect(compareBooksyWaitlists(before, after)).toEqual({
    added: [id("4")],
    changed: [{ ref: id("3"), fields: ["durationMinutes", "priority"] }],
    unchanged: 0,
    absentOnReobservedDate: [id("1")],
    absenceUnverified: [id("2")],
    previousObservedDates: 3,
    currentObservedDates: 2,
    previousIgnoredObservations: 0,
    currentIgnoredObservations: 0,
    datesWithoutNewObservation: [unchangedDay],
  });
});

test("different capture instants within one millisecond are ordered, and simultaneous conflicts fail", () => {
  const original = capture("2026-11-17T13:00:00.000001Z", [row]);
  const newDay = "2026-11-19";
  const moved = { ...row, date: newDay };
  const later = capture("2026-11-17T13:00:00.000002Z", [moved], newDay);
  const simultaneous = capture("2026-11-17T14:00:00.000001+01:00", [moved], newDay);
  expect(projectBooksyWaitlist([later, original], source).entries).toMatchObject([
    { requestedDate: newDay, sourceHash: later.sha256 },
  ]);
  expect(() => projectBooksyWaitlist([original, simultaneous], source)).toThrow(
    "conflicting requested dates",
  );
});
