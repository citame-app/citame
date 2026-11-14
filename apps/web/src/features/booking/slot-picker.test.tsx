import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { SlotPicker } from "./slot-picker";

const SERVICE = "0198f5a0-7b1c-7000-8000-000000000101";
const STAFF_A = "0198f5a0-7b1c-7000-8000-000000000201";
const STAFF_B = "0198f5a0-7b1c-7000-8000-000000000202";
const TZ = "America/Argentina/Buenos_Aires";

type Day = Array<{ startsAt: string; staffId: string }>;
let slotsByDate: Record<string, Day>;
let failFor: string | null;
let failAll = false;
let requested: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  requested = [];
  failFor = null;
  failAll = false;
  slotsByDate = {
    "2026-03-09": [],
    "2026-03-10": [
      { startsAt: "2026-03-10T12:00:00.000Z", staffId: STAFF_A },
      { startsAt: "2026-03-10T12:00:00.000Z", staffId: STAFF_B },
      { startsAt: "2026-03-10T15:30:00.000Z", staffId: STAFF_A },
      { startsAt: "2026-03-10T21:00:00.000Z", staffId: STAFF_A },
    ],
    "2026-03-11": [{ startsAt: "2026-03-11T21:00:00.000Z", staffId: STAFF_B }],
  };
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    const date = url.searchParams.get("date") ?? "";
    requested.push(date);
    if (failAll || failFor === date) {
      return new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const slots = (slotsByDate[date] ?? []).map((s) => ({
      ...s,
      endsAt: new Date(Date.parse(s.startsAt) + 3_600_000).toISOString(),
    }));
    return new Response(JSON.stringify({ date, timezone: TZ, slots }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base = {
  serviceIds: [SERVICE],
  staffId: undefined,
  dates: ["2026-03-09", "2026-03-10", "2026-03-11"],
  timeZone: TZ,
  selectedDate: undefined,
  selectedSlot: undefined,
  onChange: () => {},
  onMoreDates: undefined,
};

describe("SlotPicker", () => {
  test("shows a loading state first, then the next available day with grouped times", async () => {
    renderApp(<SlotPicker {...base} />);
    expect(screen.getByRole("status", { name: "Loading times" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /9:00/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Morning" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Afternoon" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Evening" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Tuesday, March 10/ })).toBeChecked();
  });

  test("days without availability are disabled once known and the next one is flagged", async () => {
    renderApp(<SlotPicker {...base} />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Monday, March 9/ })).toBeDisabled(),
    );
    expect(screen.getByText("Next available")).toBeInTheDocument();
  });

  test("with 'any professional' one start time shows once even if two people are free", async () => {
    renderApp(<SlotPicker {...base} />);
    await screen.findByRole("radio", { name: /9:00/ });
    expect(screen.getAllByRole("radio", { name: /9:00/ })).toHaveLength(1);
  });

  test("choosing a time reports the day and the whole slot", async () => {
    const onChange = mock();
    renderApp(<SlotPicker {...base} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("radio", { name: /12:30/ }));
    expect(onChange).toHaveBeenCalledWith({
      date: "2026-03-10",
      slot: expect.objectContaining({ startsAt: "2026-03-10T15:30:00.000Z", staffId: STAFF_A }),
    });
  });

  test("choosing another day reports it without a slot", async () => {
    const onChange = mock();
    renderApp(<SlotPicker {...base} onChange={onChange} />);
    await screen.findByRole("radio", { name: /9:00/ });
    fireEvent.click(await screen.findByRole("radio", { name: /Wednesday, March 11/ }));
    expect(onChange).toHaveBeenCalledWith({ date: "2026-03-11", slot: undefined });
  });

  test("a failing day offers a retry", async () => {
    failFor = "2026-03-10";
    renderApp(<SlotPicker {...base} selectedDate="2026-03-10" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    failFor = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio", { name: /9:00/ })).toBeInTheDocument();
  });

  test("when every day fails to load, the error is shown instead of a misleading empty state", async () => {
    failAll = true;
    renderApp(<SlotPicker {...base} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("No times left on this day")).not.toBeInTheDocument();
    failAll = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio", { name: /9:00/ })).toBeInTheDocument();
  });

  test("an empty chosen day explains itself and points at the next available day", async () => {
    renderApp(<SlotPicker {...base} selectedDate="2026-03-09" />);
    expect(await screen.findByText("No times left on this day")).toBeInTheDocument();
    const jump = screen.getByRole("button", { name: /Next available day/ });
    expect(jump).toBeInTheDocument();
  });

  test("a selected slot that is no longer offered is reported as lost", async () => {
    const onLost = mock();
    renderApp(
      <SlotPicker
        {...base}
        selectedDate="2026-03-10"
        selectedSlot="2026-03-10T13:45:00.000Z"
        onSelectionLost={onLost}
      />,
    );
    await screen.findByRole("radio", { name: /9:00/ });
    await waitFor(() => expect(onLost).toHaveBeenCalled());
  });

  test("offers more dates when the strip can grow", async () => {
    const onMore = mock();
    renderApp(<SlotPicker {...base} onMoreDates={onMore} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more dates" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });
});
