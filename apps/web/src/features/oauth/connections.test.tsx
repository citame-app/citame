import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { OAuthConnections } from "./connections";

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
  renderApp(<OAuthConnections />);
  expect(await screen.findByText("Assistant")).toBeVisible();
  expect(screen.getByText(/Book, move and cancel centre appointments/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
  expect(deletes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(deletes).toEqual(["/api/me/connections/assistant-1"]));
  expect(await screen.findByText("No apps are connected.")).toBeVisible();
});
