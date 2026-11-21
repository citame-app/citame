import { afterEach, expect, mock, test } from "bun:test";
import { intakeDefinitionSchema } from "@sob/contracts";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { BookingForms, useBookingForms } from "./booking-forms";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const QUESTION = "0198f5a0-7b1c-7000-8000-000000000001";
const revision = {
  id: "0198f5a0-7b1c-7000-8000-000000000002",
  formId: "0198f5a0-7b1c-7000-8000-000000000003",
  number: 1,
  contentHash: "1".repeat(64),
  createdAt: "2026-03-02T12:00:00.000Z",
  definition: intakeDefinitionSchema.parse({
    title: "Visit preferences",
    requiredAtBooking: true,
    fields: [{ id: QUESTION, kind: "text", label: "Style preference", required: true }],
  }),
};
function Example({ subject = "customer", team = false }: { subject?: string; team?: boolean }) {
  const forms = useBookingForms({
    serviceIds: ["0198f5a0-7b1c-7000-8000-000000000004"],
    enabled: true,
    subjectKey: subject,
    team,
  });
  return (
    <>
      <BookingForms state={forms} />
      <button type="button" disabled={!forms.ready}>
        Confirm visit
      </button>
      <output aria-label="Packet">{JSON.stringify(forms.payload)}</output>
      <button type="button" onClick={() => void forms.refresh()}>
        Refresh fixture
      </button>
    </>
  );
}
test("booking requires explicit confirmation, retains draft on read failure and resets confirmation for changed terms", async () => {
  let failed = false;
  let current = revision;
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify(
          failed
            ? { error: { code: "internal_error", message: "Read failed" } }
            : { forms: [current], reviewHash: current.contentHash, readyResponses: [] },
        ),
        { status: failed ? 500 : 200, headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  const { queryClient } = renderApp(<Example />);
  fireEvent.change(await screen.findByLabelText("Style preference"), {
    target: { value: "Keep my draft" },
  });
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I have reviewed these questions and confirm my answers."));
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeEnabled();
  expect(
    JSON.parse(screen.getByLabelText("Packet").textContent ?? "{}").intakeResponses[0].answers[
      QUESTION
    ],
  ).toBe("Keep my draft");
  failed = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["intake", "requirements"] });
  });
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeDisabled();
  expect(screen.getByLabelText("Style preference")).toHaveValue("Keep my draft");
  failed = false;
  current = {
    ...revision,
    id: "0198f5a0-7b1c-7000-8000-000000000005",
    number: 2,
    contentHash: "2".repeat(64),
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh fixture" }));
  await screen.findByText(/Version 2/);
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeDisabled();
  expect(
    screen.getByLabelText("I have reviewed these questions and confirm my answers."),
  ).not.toBeChecked();
}, 15_000);

test("team cannot fill customer-only forms", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ forms: [revision], reviewHash: revision.contentHash, readyResponses: [] }),
        { headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  renderApp(<Example team />);
  await screen.findByText(
    "This form must be completed by the client in their web booking flow before you can confirm this visit.",
  );
  expect(screen.queryByLabelText("Style preference")).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeDisabled();
});

function SwitchingClient() {
  const [subject, setSubject] = useState("first");
  return (
    <>
      <Example subject={subject} />
      <button type="button" onClick={() => setSubject("second")}>
        Choose second client
      </button>
    </>
  );
}
test("changing the selected client never carries another client's draft answers or confirmation", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ forms: [revision], reviewHash: revision.contentHash, readyResponses: [] }),
  ) as unknown as typeof fetch;
  renderApp(<SwitchingClient />);
  fireEvent.change(await screen.findByLabelText("Style preference"), {
    target: { value: "First client's draft" },
  });
  fireEvent.click(screen.getByLabelText("I have reviewed these questions and confirm my answers."));
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Choose second client" }));
  expect(await screen.findByLabelText("Style preference")).toHaveValue("");
  expect(
    screen.getByLabelText("I have reviewed these questions and confirm my answers."),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm visit" })).toBeDisabled();
});
