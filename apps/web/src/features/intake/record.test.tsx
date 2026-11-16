import { afterEach, expect, mock, test } from "bun:test";
import { intakeDefinitionSchema } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { IntakeRecord } from "./record";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
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
