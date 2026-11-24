import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
const otherKey = ["calendar-inbox", "other-account", "reception", {}];
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
    expect(await screen.findByText("Notifications are unavailable for this account")).toBeVisible();
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
