import { afterEach, expect, mock, test } from "bun:test";
import { DESKTOP_CLIENT_ID } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { desktopDevicesQuery } from "~/lib/oauth-account-queries";
import { renderApp } from "../../../test/render";
import { OAuthConnections } from "./connections";
import { DesktopDevices } from "./desktop-devices";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the profile lists scopes and revokes only the reviewed connection", async () => {
  const deletes: string[] = [];
  globalThis.fetch = mock(async (url: unknown, options?: RequestInit) => {
    if (options?.method === "DELETE") {
      deletes.push(String(url));
      return new Response(null, { status: 204 });
    }
    return Response.json({
      connections: deletes.length
        ? []
        : [
            {
              clientId: "assistant-1",
              name: "Assistant",
              updatedAt: "2026-11-17T10:00:00.000Z",
              scopes: ["schedule:write"],
            },
          ],
    });
  }) as unknown as typeof fetch;
  renderApp(<OAuthConnections userId="owner" />);
  expect(await screen.findByText("Assistant")).toBeVisible();
  expect(screen.getByText(/Book, move and cancel centre appointments/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
  expect(deletes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(deletes).toEqual(["/api/me/connections/assistant-1"]));
  expect(await screen.findByText("No apps are connected.")).toBeVisible();
});

test("removing Desktop access clears linked devices before the new fetch and discards old reads", async () => {
  const userId = "owner";
  const { queryKey } = desktopDevicesQuery(userId);
  const colleague = desktopDevicesQuery("colleague").queryKey;
  const time = "2026-11-17T10:00:00.000Z";
  const devices = {
    devices: [
      {
        id: "0198f5a0-7b1c-7000-8000-000000000099",
        label: "Front desk laptop",
        linkedAt: time,
        lastSeenAt: time,
      },
    ],
  };
  const stale = Promise.withResolvers<Response>();
  const refreshed = Promise.withResolvers<Response>();
  let withdrawn = false;
  let pendingSignal: AbortSignal | null | undefined;
  let reads = 0;
  globalThis.fetch = mock(async (url: unknown, options?: RequestInit) => {
    if (String(url).endsWith("/me/desktop-devices")) {
      reads += 1;
      if (reads === 1) return Response.json(devices);
      if (reads === 2) {
        pendingSignal = options?.signal;
        return stale.promise;
      }
      return refreshed.promise;
    }
    if (
      String(url).endsWith(`/me/connections/${DESKTOP_CLIENT_ID}`) &&
      options?.method === "DELETE"
    ) {
      withdrawn = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      connections: withdrawn
        ? []
        : [
            {
              clientId: DESKTOP_CLIENT_ID,
              name: "Citame Desktop",
              updatedAt: time,
              scopes: ["desktop:sign-in"],
            },
          ],
    });
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(
    <>
      <DesktopDevices userId={userId} />
      <OAuthConnections userId={userId} />
    </>,
  );
  try {
    expect(await screen.findByText("Front desk laptop")).toBeVisible();
    queryClient.setQueryData(colleague, devices);
    act(() => {
      void queryClient.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(pendingSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    const confirm = screen.getByRole("button", { name: "Confirm removal" });
    expect(confirm).toHaveAccessibleDescription(/disconnects every Desktop device/i);
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("No desktop devices linked.")).toBeVisible();
    expect(screen.queryByText("Front desk laptop")).toBeNull();
    expect(pendingSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(colleague)).toEqual(devices);
    expect(screen.getByRole("heading", { name: "Connected apps" })).toHaveFocus();
    await act(async () => stale.resolve(Response.json(devices)));
    expect(screen.queryByText("Front desk laptop")).toBeNull();
  } finally {
    await act(async () => {
      stale.resolve(Response.json(devices));
      refreshed.resolve(Response.json({ devices: [] }));
    });
  }
  expect(await screen.findByText("Access removed")).toBeVisible();
});
