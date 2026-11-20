import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { liveQueryKeys } from "../admin/calendar/live-queries";
import { ReviewRequests } from "./review-requests";

const originalFetch = globalThis.fetch;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const appointmentId = "0198f5a0-7b1c-7000-8000-000000000001";
const link = `https://example.test/account/reviews?appointmentId=${appointmentId}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

test("copying a review link confirms success and offers manual copy after clipboard denial", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      visits: [
        { appointmentId, clientName: "Test client", startsAt: "2026-03-02T12:00:00.000Z", link },
      ],
      hasMore: false,
    }),
  ) as unknown as typeof fetch;
  const writeText = mock(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  renderApp(<ReviewRequests />);
  const copyButton = await screen.findByRole("button", { name: "Copy review link" });

  fireEvent.click(copyButton);
  expect(await screen.findByText("Link copied")).toHaveAttribute("role", "status");
  expect(writeText).toHaveBeenCalledWith(link);

  writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  fireEvent.click(copyButton);
  expect(await screen.findByRole("textbox", { name: "Review link" })).toHaveValue(link);
  expect(screen.getByText("Copy the link manually")).toHaveAttribute("role", "status");
  expect(copyButton).toBeEnabled();
});

test("email requests require confirmation and show the queued delivery status", async () => {
  const request = mock(async (_url: string) => Response.json({ status: "pending" }));
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return request(String(input));
    return Response.json({
      visits: [
        {
          appointmentId,
          clientName: "Test client",
          startsAt: "2026-03-02T12:00:00.000Z",
          link,
          canEmail: true,
        },
      ],
      hasMore: false,
      emailEnabled: true,
    });
  }) as unknown as typeof fetch;
  renderApp(<ReviewRequests />);
  const open = await screen.findByRole("button", { name: "Send by email" });
  fireEvent.click(open);
  let dialog = await screen.findByRole("dialog", { name: "Email a review request?" });
  expect(dialog.textContent).toContain("Test client");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(request).not.toHaveBeenCalled();

  fireEvent.click(open);
  dialog = await screen.findByRole("dialog", { name: "Email a review request?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send by email" }));
  expect(await screen.findByText("Email queued")).toHaveAttribute("role", "status");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toContain(`/admin/reviews/requests/${appointmentId}/email`);
});

test("a live refresh updates the invitation and drops rows after revocation", async () => {
  const read = mock(async () =>
    Response.json({
      visits: [
        { appointmentId, clientName: "Test client", startsAt: "2026-03-02T12:00:00.000Z", link },
      ],
      hasMore: false,
    }),
  );
  globalThis.fetch = read as unknown as typeof fetch;
  const { queryClient } = renderApp(<ReviewRequests />);
  await screen.findByText("Test client");
  read.mockImplementation(async () =>
    Response.json({
      visits: [
        {
          appointmentId,
          clientName: "Test client",
          startsAt: "2026-03-02T12:00:00.000Z",
          link,
          emailStatus: "sent",
        },
      ],
      hasMore: false,
    }),
  );
  for (const queryKey of liveQueryKeys(["review_requests"])) {
    await act(() => queryClient.invalidateQueries({ queryKey }));
  }
  expect(await screen.findByText("Email sent")).toBeInTheDocument();

  read.mockImplementation(async () =>
    Response.json({ error: { code: "forbidden", message: "Access denied" } }, { status: 403 }),
  );
  await act(async () => {
    await Promise.all(
      Array.from(liveQueryKeys(["staff"]), (queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  });
  await screen.findByRole("alert");
  expect(screen.queryByText("Test client")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy review link" })).toBeNull();
});
