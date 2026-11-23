import { expect, test } from "bun:test";
import type { CalendarResponse } from "@sob/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ResourceCalendar } from "./resource-calendar";

test("occupancy adds simultaneous units, excludes expired holds, and keeps untouched columns grouped", () => {
  const calendar: CalendarResponse = {
    timezone: "America/Argentina/Buenos_Aires",
    from: "2026-03-09T03:00:00Z",
    to: "2026-03-10T03:00:00Z",
    staff: [],
    appointments: [],
    timeOff: [],
    workingWindows: [],
    resourceOccupancy: {
      capturedAt: "2026-03-09T09:01:00Z",
      pools: [
        {
          id: "room",
          name: "Spa room",
          capacity: 2,
          active: true,
          kind: "room",
          windows: [
            { startsAt: "2026-03-09T12:00:00Z", endsAt: "2026-03-09T14:00:00Z", quantity: 1 },
            {
              startsAt: "2026-03-09T13:00:00Z",
              endsAt: "2026-03-09T14:00:00Z",
              quantity: 1,
              holdExpiresAt: "2026-03-09T10:00:00Z",
            },
            {
              startsAt: "2026-03-09T13:00:00Z",
              endsAt: "2026-03-09T14:00:00Z",
              quantity: 2,
              holdExpiresAt: "2026-03-09T09:01:00Z",
            },
          ],
        },
        {
          id: "other",
          name: "Spare room",
          capacity: 3,
          active: true,
          kind: "room",
          windows: [],
        },
      ],
    },
  };
  renderApp(<ResourceCalendar calendar={calendar} onOpen={() => {}} />);
  const table = screen.getByRole("table", { name: "Resources" });
  expect(within(table).getByRole("columnheader", { name: "Spa room Capacity 2" })).toBeVisible();
  expect(
    within(table).getByRole("cell", { name: "2/2 reserved 1 held for waitlist" }),
  ).toBeVisible();
  expect(within(table).getByRole("cell", { name: "0/3 reserved" })).toHaveAttribute("rowspan", "4");
  expect(within(table).queryByText("4/2 reserved")).toBeNull();
});

test("a hold expires relative to the server snapshot even with a different browser clock", async () => {
  const calendar: CalendarResponse = {
    timezone: "America/Argentina/Buenos_Aires",
    from: "2026-03-09T03:00:00Z",
    to: "2026-03-10T03:00:00Z",
    staff: [],
    appointments: [],
    timeOff: [],
    workingWindows: [],
    resourceOccupancy: {
      capturedAt: "2026-03-09T09:01:00Z",
      pools: [
        {
          id: "room",
          name: "Spa room",
          capacity: 1,
          active: true,
          kind: "room",
          windows: [
            {
              startsAt: "2026-03-09T12:00:00Z",
              endsAt: "2026-03-09T13:00:00Z",
              holdExpiresAt: "2026-03-09T09:01:00.100Z",
              quantity: 1,
            },
          ],
        },
      ],
    },
  };
  const { unmount } = renderApp(<ResourceCalendar calendar={calendar} onOpen={() => {}} />);
  expect(screen.getByText("1 held for waitlist")).toBeInTheDocument();
  await waitFor(() => expect(Boolean(screen.queryByText("1 held for waitlist"))).toBe(false));
  expect(screen.getByText("0/1 reserved")).toBeInTheDocument();
  unmount();
  renderApp(<ResourceCalendar calendar={calendar} onOpen={() => {}} />);
  expect(screen.queryByText("1 held for waitlist")).toBeNull();
  expect(screen.getByText("0/1 reserved")).toBeInTheDocument();
});
