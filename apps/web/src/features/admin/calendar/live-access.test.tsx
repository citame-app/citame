import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { calendarQuery } from "~/lib/admin-queries";
import { renderApp } from "../../../../test/render";
import { CalendarLiveProvider } from "./live-provider";

const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const colleagueId = "0198f5a0-7b1c-7000-8000-000000000202";
const date = { from: "2026-11-23T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
const fetchBefore = globalThis.fetch;
const eventSourceBefore = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = fetchBefore;
  globalThis.EventSource = eventSourceBefore;
});

class Stream extends EventTarget {
  static instance: Stream;
  readyState = 1;
  constructor() {
    super();
    Stream.instance = this;
  }
  close() {
    this.readyState = 2;
  }
  send(seq: number) {
    this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq }) }));
  }
}

function CalendarNavigation() {
  const [opened, setOpened] = useState(false);
  const query = useQuery({ ...calendarQuery(date), enabled: opened });
  return opened ? (
    query.isSuccess && <p>Calendar loaded</p>
  ) : (
    <button type="button" onClick={() => setOpened(true)}>
      Open calendar
    </button>
  );
}

test("live changes refresh the affected staff session without refreshing colleagues", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  let seq = 11;
  let id = colleagueId;
  const pull = mock(async () =>
    Response.json({
      changes: [{ seq, entity: "staff", id, op: "delete", data: null }],
      nextCursor: seq,
      headSeq: seq,
      hasMore: false,
    }),
  );
  globalThis.fetch = pull as unknown as typeof fetch;
  const refreshAccess = mock(async (_signal: AbortSignal) => {});
  renderApp(
    <CalendarLiveProvider staffId={staffId} refreshAccess={refreshAccess}>
      Agenda
    </CalendarLiveProvider>,
  );
  act(() => Stream.instance.send(10));
  expect(refreshAccess).toHaveBeenCalledTimes(1);
  await act(async () => Stream.instance.send(11));
  expect(pull).toHaveBeenCalledTimes(1);
  expect(refreshAccess).toHaveBeenCalledTimes(1);

  id = staffId;
  seq = 12;
  act(() => Stream.instance.send(12));
  await waitFor(() => expect(refreshAccess).toHaveBeenCalledTimes(2));
  expect(refreshAccess.mock.calls[0]?.[0].aborted).toBe(true);
});

test("a live appointment change replaces an in-flight first calendar load", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const staleResponse = Promise.withResolvers<Response>();
  let firstSignal: AbortSignal | null | undefined;
  let calendarRequests = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/appointments/calendar")) {
      if (++calendarRequests === 1) {
        firstSignal = init?.signal;
        return staleResponse.promise;
      }
      return Response.json({
        ...date,
        appointments: [],
        staff: [],
        timeOff: [],
        workingWindows: [],
        timezone: "Europe/Madrid",
      });
    }
    return Response.json({
      changes: [{ seq: 11, entity: "appointment", id: staffId, op: "delete", data: null }],
      nextCursor: 11,
      headSeq: 11,
      hasMore: false,
    });
  }) as unknown as typeof fetch;
  const view = renderApp(
    <CalendarLiveProvider>
      <CalendarNavigation />
    </CalendarLiveProvider>,
  );
  const refresh = spyOn(view.queryClient, "invalidateQueries");
  try {
    act(() => Stream.instance.send(10));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ["admin", "calendar"] }));
    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    expect(calendarRequests).toBe(1);
    act(() => Stream.instance.send(11));
    expect(await screen.findByText("Calendar loaded")).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    expect(calendarRequests).toBe(2);
  } finally {
    staleResponse.resolve(Response.json({}));
    refresh.mockRestore();
  }
});
