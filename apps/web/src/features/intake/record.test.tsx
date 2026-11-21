import { afterEach, expect, mock, test } from "bun:test";
import { intakeDefinitionSchema } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { CalendarLiveProvider } from "~/features/admin/calendar/live-provider";
import { renderApp } from "../../../test/render";
import { IntakeRecord } from "./record";

const original = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = original;
  globalThis.EventSource = originalEventSource;
});
test("the client record loads private answers only when opening a response and shows its original wording", async () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000001";
  const revisionId = "0198f5a0-7b1c-7000-8000-000000000002";
  const clientId = "0198f5a0-7b1c-7000-8000-000000000003";
  const question = "0198f5a0-7b1c-7000-8000-000000000004";
  const requests: string[] = [];
  globalThis.fetch = mock(async (input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    requests.push(path);
    if (path.includes("/submissions/"))
      return Response.json({
        id,
        clientId,
        appointmentId: null,
        source: "client",
        confirmationVersion: "intake-response-v1",
        createdAt: "2026-03-02T12:00:00.000Z",
        answers: { [question]: "Original private answer" },
        revision: {
          id: revisionId,
          formId: revisionId,
          number: 1,
          contentHash: "1".repeat(64),
          createdAt: "2026-03-02T12:00:00.000Z",
          definition: intakeDefinitionSchema.parse({
            title: "Original visit form",
            fields: [{ id: question, kind: "text", label: "Original question" }],
          }),
        },
      });
    return Response.json({
      submissions: [
        {
          id,
          clientId,
          appointmentId: null,
          source: "client",
          createdAt: "2026-03-02T12:00:00.000Z",
          revisionId,
          formId: revisionId,
          formTitle: "Original visit form",
          number: 1,
        },
      ],
      nextCursor: null,
    });
  }) as unknown as typeof fetch;
  renderApp(<IntakeRecord clientId={clientId} />);
  await screen.findByText("Original visit form");
  expect(requests.some((path) => path.includes("/submissions/"))).toBe(false);
  expect(screen.queryByText("Original private answer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View response" }));
  await screen.findByText("Original question");
  await screen.findByText("Original private answer");
  await screen.findByText(/Completed by the client/);
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("a remote intake event refreshes the open client history without reading answers", async () => {
  class LiveConnection extends EventTarget {
    static instance: LiveConnection | undefined;
    readyState = 1;
    onopen = null;
    onerror = null;
    constructor() {
      super();
      LiveConnection.instance = this;
    }
    close() {
      this.readyState = 2;
    }
    receive(seq: number) {
      this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq }) }));
    }
  }
  globalThis.EventSource = LiveConnection as unknown as typeof EventSource;
  const clientId = "0198f5a0-7b1c-7000-8000-000000000003";
  const id = "0198f5a0-7b1c-7000-8000-000000000001";
  let recorded = false;
  const paths: string[] = [];
  globalThis.fetch = mock(async (input) => {
    const url = new URL(String(input), "http://localhost");
    paths.push(url.pathname);
    if (url.pathname.endsWith("/sync/pull")) {
      expect(url.searchParams.get("intakeViews")).toBe("1");
      return Response.json({
        changes: [],
        refresh: ["intake_records"],
        nextCursor: 11,
        headSeq: 11,
        hasMore: false,
      });
    }
    return Response.json({
      submissions: recorded
        ? [
            {
              id,
              clientId,
              appointmentId: null,
              source: "team",
              revisionId: id,
              formId: id,
              formTitle: "Received from another device",
              number: 1,
              createdAt: "2026-03-02T12:00:00.000Z",
            },
          ]
        : [],
      nextCursor: null,
    });
  }) as unknown as typeof fetch;
  renderApp(
    <CalendarLiveProvider>
      <IntakeRecord clientId={clientId} />
    </CalendarLiveProvider>,
  );
  await screen.findByText("No form responses recorded yet.");
  const source = LiveConnection.instance;
  if (!source) throw new Error("Expected a managed live connection");
  await act(async () => source.receive(10));
  const historyRequests = () => paths.filter((path) => path.endsWith("/intake"));
  await waitFor(() => expect(historyRequests()).toHaveLength(2));
  expect(screen.getByText("No form responses recorded yet.")).toBeVisible();
  recorded = true;
  await act(async () => source.receive(11));
  await screen.findByText("Received from another device");
  expect(historyRequests()).toHaveLength(3);
  expect(paths.some((path) => path.includes("/intake/submissions/"))).toBe(false);
});
