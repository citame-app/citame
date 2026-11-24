import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { calendarQuery, reportQuery } from "~/lib/admin-queries";
import { renderApp } from "../../../../test/render";
import { CalendarInbox } from "./inbox";
import { CalendarLiveProvider } from "./live-provider";
import { CalendarWaitlist } from "./waitlist";

const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const colleagueId = "0198f5a0-7b1c-7000-8000-000000000202";
const date = { from: "2026-11-23T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
const reportDates = { from: "2026-11-23", to: "2026-11-23" };
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

function InboxNavigation() {
  const [open, setOpen] = useState(false);
  return open ? (
    <CalendarInbox userId="operator" accessScope="reception" />
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Open inbox workspace
    </button>
  );
}

function WaitlistNavigation() {
  const [opened, setOpened] = useState(false);
  return opened ? (
    <CalendarWaitlist
      viewer={{ userId: "operator", accessScope: "manager" }}
      fromDate="2026-11-23"
      toDate="2026-11-23"
      role="owner"
      ownStaffId={null}
    />
  ) : (
    <button type="button" onClick={() => setOpened(true)}>
      Open waitlist workspace
    </button>
  );
}

function OverviewNavigation() {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    ...reportQuery({ ...reportDates, businessOverview: "1" }),
    enabled: opened,
  });
  return opened ? (
    query.data && <p>Clients served: {query.data.businessOverview?.visitingClients}</p>
  ) : (
    <button type="button" onClick={() => setOpened(true)}>
      Open overview
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

test("a live appointment notice replaces a pending first inbox read", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const pending = Promise.withResolvers<Response>();
  let requests = 0;
  let staleSignal: AbortSignal | null | undefined;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/admin/notifications/inbox")) {
      if (++requests === 1) {
        staleSignal = init?.signal;
        return pending.promise;
      }
      return Response.json({ entries: [], total: 2, page: 1, pageSize: 25 });
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
      <InboxNavigation />
    </CalendarLiveProvider>,
  );
  const refresh = spyOn(view.queryClient, "invalidateQueries");
  try {
    act(() => Stream.instance.send(10));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ["calendar-inbox"] }));
    fireEvent.click(screen.getByRole("button", { name: "Open inbox workspace" }));
    expect(requests).toBe(1);
    act(() => Stream.instance.send(11));
    expect(await screen.findByRole("button", { name: "Notifications 2" })).toBeVisible();
    expect(staleSignal?.aborted).toBe(true);
    expect(requests).toBe(2);
  } finally {
    pending.resolve(Response.json({ entries: [], total: 0, page: 1, pageSize: 25 }));
    refresh.mockRestore();
  }
});

test("a client merge replaces the in-flight first business overview load", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const report = (visitingClients: number) => ({
    ...reportDates,
    timezone: "Europe/Madrid",
    staffId: null,
    totals: {
      appointments: 2,
      byStatus: { booked: 0, completed: 2, cancelled: 0, no_show: 0 },
      revenueCents: 0,
      noShowRate: 0,
    },
    series: [],
    topServices: [],
    perStaff: [],
    businessOverview: {
      visitingClients,
      occupancyRate: null,
      netCollectedCents: 0,
      lowStockProducts: 0,
    },
  });
  const staleResponse = Promise.withResolvers<Response>();
  let firstSignal: AbortSignal | null | undefined;
  const summary = mock(async (signal: AbortSignal | null | undefined) => {
    if (summary.mock.calls.length === 1) {
      firstSignal = signal;
      return staleResponse.promise;
    }
    return Response.json(report(1));
  });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/admin/reports/summary")) return summary(init?.signal);
    return Response.json({
      changes: [{ seq: 11, entity: "client", id: colleagueId, op: "delete", data: null }],
      nextCursor: 11,
      headSeq: 11,
      hasMore: false,
    });
  }) as unknown as typeof fetch;
  const view = renderApp(
    <CalendarLiveProvider>
      <OverviewNavigation />
    </CalendarLiveProvider>,
  );
  const refresh = spyOn(view.queryClient, "invalidateQueries");
  try {
    act(() => Stream.instance.send(10));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ["admin", "report"] }));
    fireEvent.click(screen.getByRole("button", { name: "Open overview" }));
    expect(summary).toHaveBeenCalledTimes(1);
    act(() => Stream.instance.send(11));
    expect(await screen.findByText("Clients served: 1")).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    expect(summary).toHaveBeenCalledTimes(2);
    await act(async () => staleResponse.resolve(Response.json(report(2))));
    expect(screen.queryByText("Clients served: 2")).toBeNull();
  } finally {
    staleResponse.resolve(Response.json(report(2)));
    refresh.mockRestore();
  }
});

function ReceiptNavigation({
  readReceipt,
}: {
  readReceipt: (signal: AbortSignal) => Promise<string>;
}) {
  const [opened, setOpened] = useState(false);
  const receipt = useQuery({
    queryKey: ["commerce", "admin", "checkout", staffId],
    queryFn: ({ signal }) => readReceipt(signal),
    enabled: opened,
  });
  return opened ? (
    receipt.data && <p>{receipt.data}</p>
  ) : (
    <button type="button" onClick={() => setOpened(true)}>
      Open receipt
    </button>
  );
}

test("a live bank reservation replaces an in-flight first checkout load", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const stale = Promise.withResolvers<string>();
  let firstSignal: AbortSignal | undefined;
  const readReceipt = mock((signal: AbortSignal) => {
    if (readReceipt.mock.calls.length > 1) return Promise.resolve("Bank order pending");
    firstSignal = signal;
    return stale.promise;
  });
  globalThis.fetch = mock(async () =>
    Response.json({
      changes: [],
      refresh: ["commerce"],
      nextCursor: 11,
      headSeq: 11,
      hasMore: false,
    }),
  ) as unknown as typeof fetch;

  const view = renderApp(
    <CalendarLiveProvider>
      <ReceiptNavigation readReceipt={readReceipt} />
    </CalendarLiveProvider>,
  );
  const refresh = spyOn(view.queryClient, "invalidateQueries");
  try {
    act(() => Stream.instance.send(10));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ["commerce"] }));
    fireEvent.click(screen.getByRole("button", { name: "Open receipt" }));
    expect(readReceipt).toHaveBeenCalledTimes(1);
    act(() => Stream.instance.send(11));
    expect(await screen.findByText("Bank order pending")).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => stale.resolve("Stale receipt"));
    expect(screen.queryByText("Stale receipt")).toBeNull();
  } finally {
    stale.resolve("Stale receipt");
    refresh.mockRestore();
  }
});

test("a live waitlist change replaces an in-flight first calendar count", async () => {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  const counts = (total: number) =>
    Response.json({
      entries: [],
      policy: { enabled: true, offerMinutes: 30, version: 1 },
      page: 1,
      pageSize: 1,
      total,
    });
  const fetchCount = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (fetchCount.mock.calls.length === 1) {
      signal = init?.signal;
      return pending.promise;
    }
    return counts(2);
  });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/admin/waitlist")) return fetchCount(input, init);
    return Response.json({
      changes: [{ seq: 11, entity: "waitlist", id: staffId, op: "delete", data: null }],
      nextCursor: 11,
      headSeq: 11,
      hasMore: false,
    });
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(
    <CalendarLiveProvider>
      <WaitlistNavigation />
    </CalendarLiveProvider>,
  );
  const refresh = spyOn(queryClient, "invalidateQueries");
  try {
    act(() => Stream.instance.send(10));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ["waitlist"] }));
    fireEvent.click(screen.getByRole("button", { name: "Open waitlist workspace" }));
    expect(fetchCount).toHaveBeenCalledTimes(1);
    act(() => Stream.instance.send(11));
    expect(await screen.findByRole("button", { name: "View waitlist (2)" })).toBeVisible();
    expect(signal?.aborted).toBe(true);
    expect(fetchCount).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(counts(1)));
    expect(screen.getByRole("button", { name: "View waitlist (2)" })).toBeVisible();
  } finally {
    pending.resolve(counts(1));
    refresh.mockRestore();
  }
});
