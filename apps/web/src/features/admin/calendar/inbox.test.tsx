import { afterEach, expect, mock, test } from "bun:test";
import { CALENDAR_INBOX_SCOPE_HEADER } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { renderApp } from "../../../../test/render";
import { CalendarInbox } from "./inbox";

const realFetch = globalThis.fetch;
const userId = "front-desk";
const countKey = ["calendar-inbox", userId, "reception", {}];
const archivedKey = [
  "calendar-inbox",
  userId,
  "previous-scope",
  { archived: "true", kind: "new", page: 2 },
];
const otherKey = ["calendar-inbox", "other-account", "other-reception", {}];
const page = (total: number) => ({ entries: [], total, page: 1, pageSize: 25 });

function WithScope() {
  const [scope, setScope] = useState("reception");
  return (
    <>
      <button type="button" onClick={() => setScope("own-calendar")}>
        Use own calendar
      </button>
      <CalendarInbox userId={userId} accessScope={scope} />
    </>
  );
}

function SwitchingInbox({ accountChanged }: { accountChanged: Promise<void> }) {
  const [account, setAccount] = useState(userId);
  useEffect(() => {
    let mounted = true;
    void accountChanged.then(() => {
      if (mounted) setAccount("other-account");
    });
    return () => {
      mounted = false;
    };
  }, [accountChanged]);
  return (
    <CalendarInbox
      userId={account}
      accessScope={account === userId ? "reception" : "other-reception"}
    />
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test.each([401, 403])(
  "an inbox denial discards every saved filter for that account (%s)",
  async (status) => {
    const delayedCount = Promise.withResolvers<Response>();
    const pendingFetch = Promise.withResolvers<AbortSignal>();
    let countCalls = 0;
    let canRead = false;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/admin/notifications/inbox");
      if (!url.search) {
        countCalls += 1;
        if (countCalls === 2) {
          if (!init?.signal) throw new Error("Expected a cancellable inbox request");
          pendingFetch.resolve(init.signal);
          return delayedCount.promise;
        }
        return Response.json(page(canRead ? 2 : 5));
      }
      if (canRead) return Response.json(page(0));
      return Response.json({}, { status });
    }) as unknown as typeof fetch;
    const { queryClient } = renderApp(<CalendarInbox userId={userId} accessScope="reception" />);
    const open = await screen.findByRole("button", { name: "Notifications 5" });
    queryClient.setQueryData(archivedKey, page(30));
    queryClient.setQueryData(otherKey, page(8));

    const refetch = queryClient.refetchQueries({ queryKey: countKey, exact: true });
    const outstanding = await pendingFetch.promise;
    fireEvent.click(open);
    const unavailable = "Notifications are unavailable for this account";
    expect(await screen.findByRole("heading", { name: unavailable })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(unavailable);
    expect(
      await screen.findByRole("button", { name: "Notifications", hidden: true }),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(countKey)).toBeNull();
    expect(queryClient.getQueryData(archivedKey)).toBeNull();
    expect(queryClient.getQueryData(otherKey)).toEqual(page(8));
    expect(outstanding.aborted).toBe(true);

    await act(async () => {
      delayedCount.resolve(Response.json(page(50)));
      await refetch;
    });
    expect(queryClient.getQueryData(countKey)).toBeNull();

    canRead = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No notifications")).toBeVisible();
    await waitFor(() => expect(queryClient.getQueryData(countKey)).toEqual(page(2)));
  },
);

test("a narrower calendar scope never renders a wider cached inbox count", async () => {
  const staffCount = Promise.withResolvers<Response>();
  let calls = 0;
  globalThis.fetch = mock(async () =>
    ++calls === 1 ? Response.json(page(5)) : staffCount.promise,
  ) as unknown as typeof fetch;
  renderApp(<WithScope />);
  expect(await screen.findByRole("button", { name: "Notifications 5" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Use own calendar" }));
  expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Notifications 5" })).toBeNull();
  staffCount.resolve(Response.json(page(1)));
  expect(await screen.findByRole("button", { name: "Notifications 1" })).toBeVisible();
});

test("a delayed archive denial clears only the account that attempted to archive", async () => {
  const archiveStarted = Promise.withResolvers<void>();
  const archiveResult = Promise.withResolvers<Response>();
  const accountChanged = Promise.withResolvers<void>();
  const date = "2026-11-25T12:00:00.000Z";
  const id = "0198f5a0-7b1c-7000-8000-000000000100";
  const notice = {
    id,
    kind: "new",
    createdAt: date,
    startsAt: date,
    appointmentStartsAt: date,
    appointmentId: id,
    staffId: id,
    clientName: "Synthetic customer",
    serviceNames: ["Haircut"],
  };
  let switched = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const expectedScope = new Headers(init?.headers).get(CALENDAR_INBOX_SCOPE_HEADER);
    if (init?.method === "POST") {
      expect(expectedScope).toBe("reception");
      archiveStarted.resolve();
      return archiveResult.promise;
    }
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/admin/notifications/inbox")
      expect(expectedScope).toBe(switched ? "other-reception" : "reception");
    if (switched) return Response.json(page(url.search ? 0 : 7));
    return Response.json({ ...page(1), entries: url.search ? [notice] : [] });
  }) as unknown as typeof fetch;

  const { queryClient } = renderApp(<SwitchingInbox accountChanged={accountChanged.promise} />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications 1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
  await archiveStarted.promise;
  queryClient.setQueryData(archivedKey, page(3));

  await act(async () => {
    switched = true;
    accountChanged.resolve();
  });
  await waitFor(() => expect(queryClient.getQueryData(otherKey)).toEqual(page(7)));
  await act(async () => {
    archiveResult.resolve(Response.json({}, { status: 403 }));
  });
  await waitFor(() => expect(queryClient.getQueryData(archivedKey)).toBeNull());
  expect(queryClient.getQueryData(countKey)).toBeNull();
  expect(queryClient.getQueryData(otherKey)).toEqual(page(7));
  expect(
    screen.queryByRole("heading", { name: "Notifications are unavailable for this account" }),
  ).toBeNull();
});
