import { afterEach, expect, mock, test } from "bun:test";
import { shiftDate } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { DateShiftEditor } from "./date-shifts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const day = (date: string) => ({
  date,
  version: 0,
  ranges: null,
  effectiveRanges: [{ startTime: "09:00", endTime: "18:00" }],
});
test("dated changes require an explicit review and an uncertain apply retries the original batch identifier", async () => {
  const commits: { idempotencyKey: string }[] = [];
  let failed = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST" && path.endsWith("/preview"))
      return Response.json({
        staffId: STAFF,
        timezone: "Europe/Madrid",
        reviewHash: "1".repeat(64),
        changes: [
          {
            date: "2026-03-09",
            previous: day("2026-03-09"),
            next: {
              ...day("2026-03-09"),
              version: 1,
              ranges: [{ startTime: "12:00", endTime: "14:00" }],
              effectiveRanges: [{ startTime: "12:00", endTime: "14:00" }],
            },
          },
        ],
        conflicts: [],
        withdrawnOffers: 0,
      });
    if (init?.method === "POST") {
      commits.push(JSON.parse(String(init.body)));
      if (!failed) {
        failed = true;
        throw new TypeError("Lost apply response");
      }
    }
    return Response.json({
      staffId: STAFF,
      timezone: "Europe/Madrid",
      days: Array.from({ length: 7 }, (_, i) => day(shiftDate("2026-03-09", i))),
      conflicts: [],
      replayed: commits.length > 0,
      withdrawnOffers: 0,
    });
  }) as unknown as typeof fetch;
  renderApp(<DateShiftEditor staffId={STAFF} editable now={new Date("2026-03-09T12:00Z")} />);
  const group = await screen.findByRole("group", { name: "Monday, March 9" });
  fireEvent.change(within(group).getByLabelText("Schedule mode"), { target: { value: "custom" } });
  fireEvent.change(within(group).getByLabelText("Start 1"), { target: { value: "12:00" } });
  fireEvent.change(within(group).getByLabelText("End 1"), { target: { value: "14:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const review = await screen.findByRole("dialog", { name: "Review dated shifts" });
  expect(commits).toHaveLength(0);
  fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed shifts" }));
  await within(review).findByRole("alert");
  fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed shifts" }));
  await waitFor(() => expect(commits).toHaveLength(2));
  expect(commits[1]?.idempotencyKey).toBe(commits[0]?.idempotencyKey);
  await screen.findByText("Dated shifts saved");
});
test("read-only professionals can inspect their dates without shift editing or copying controls", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      staffId: STAFF,
      timezone: "Europe/Madrid",
      days: [day("2026-03-09")],
      conflicts: [],
    }),
  ) as unknown as typeof fetch;
  renderApp(
    <DateShiftEditor staffId={STAFF} editable={false} now={new Date("2026-03-09T12:00Z")} />,
  );
  await screen.findByRole("group", { name: "Monday, March 9" });
  expect(screen.getByLabelText("Schedule mode")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy a period" })).toBeNull();
});
