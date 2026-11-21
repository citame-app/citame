import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { IntakeAdmin } from "./form-admin";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("a blank form saves a private draft before an explicit publication review", async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let saved: unknown;
  globalThis.fetch = mock(async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (!init?.method || init.method === "GET")
      return Response.json(
        path.endsWith("/intake-forms") ? { forms: saved ? [saved] : [] } : { services: [] },
      );
    const body = JSON.parse(String(init.body));
    writes.push({ path, body });
    saved = {
      id: "0198f5a0-7b1c-7000-8000-000000000003",
      version: 1,
      active: false,
      draft: body.definition,
      published: null,
      updatedAt: "2026-03-02T12:00:00.000Z",
    };
    return Response.json(saved, { status: 201 });
  }) as unknown as typeof fetch;
  renderApp(<IntakeAdmin />);
  fireEvent.click(await screen.findByRole("button", { name: "New form" }));
  fireEvent.change(screen.getByLabelText("Form title"), { target: { value: "Visit preferences" } });
  fireEvent.change(screen.getByLabelText("Question text"), {
    target: { value: "Your preferences" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toMatchObject({
    definition: { title: "Visit preferences", requiredAtBooking: false, allowTeamResponses: false },
  });
  await screen.findByText("Draft saved");
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  await screen.findByRole("dialog", { name: "Review and publish" });
  expect(writes).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Publish this version" })).toBeVisible();
});

test("a stale draft remains intact until an explicit reload fetches the latest version", async () => {
  const definition = {
    kind: "intake",
    title: "Original",
    description: "",
    fields: [
      {
        id: "0198f5a0-7b1c-7000-8000-000000000001",
        kind: "text",
        label: "Preferences",
        help: "",
        required: false,
        maxLength: 200,
      },
    ],
    requiredAtBooking: false,
    allowTeamResponses: false,
    allServices: true,
    serviceIds: [],
  };
  let current = {
    id: "0198f5a0-7b1c-7000-8000-000000000003",
    version: 1,
    active: false,
    draft: definition,
    published: null,
    updatedAt: "2026-03-02T12:00:00.000Z",
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      current = {
        ...current,
        version: 2,
        draft: { ...definition, title: "Colleague's saved title" },
      };
      return Response.json(
        { error: { code: "version_conflict", message: "Changed" } },
        { status: 409 },
      );
    }
    return Response.json(
      String(input).includes("intake-forms") ? { forms: [current] } : { services: [] },
    );
  }) as unknown as typeof fetch;
  renderApp(<IntakeAdmin />);
  fireEvent.change(await screen.findByLabelText("Edit form"), { target: { value: current.id } });
  fireEvent.change(screen.getByLabelText("Form title"), {
    target: { value: "Unsaved local title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Form title")).toHaveValue("Unsaved local title");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Discard draft changes" });
  fireEvent.click(
    (await import("@testing-library/react"))
      .within(dialog)
      .getByRole("button", { name: "Discard draft changes" }),
  );
  await waitFor(() => expect(screen.getByLabelText("Form title")).toHaveValue("Original"));
  fireEvent.click(screen.getByRole("button", { name: "Reload current forms" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Form title")).toHaveValue("Colleague's saved title"),
  );
});

test("a live newer form version leaves the dirty form visible and prevents a stale write", async () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000003";
  const original = {
    id,
    version: 1,
    active: false,
    draft: {
      title: "Original",
      description: "",
      kind: "intake",
      requiredAtBooking: false,
      allowTeamResponses: false,
      allServices: true,
      serviceIds: [],
      fields: [
        { id, label: "Preferences", help: "", required: false, kind: "text", maxLength: 120 },
      ],
    },
    published: null,
    updatedAt: "2026-03-02T12:00:00.000Z",
  };
  const fetch = mock(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes("intake-forms") ? { forms: [original] } : { services: [] },
    ),
  );
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  const { queryClient } = renderApp(<IntakeAdmin />);
  fireEvent.change(await screen.findByLabelText("Edit form"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Form title"), { target: { value: "Unsaved title" } });
  await act(async () => {
    queryClient.setQueryData(["intake", "admin"], {
      forms: [{ ...original, version: 2, draft: { ...original.draft, title: "New cloud title" } }],
    });
  });
  await screen.findByText(/A newer version is available/);
  expect(screen.getByLabelText("Form title")).toHaveValue("Unsaved title");
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
});
