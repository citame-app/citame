import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientTransfer } from "./client-transfer";

const originalFetch = globalThis.fetch;
const CSV = "name,email\nNora,nora@example.com\nExisting,existing@example.com";
const plan = {
  reviewHash: "a".repeat(64),
  counts: { create: 1, duplicate: 1, invalid: 0, ambiguous: 0 },
  rows: [
    {
      row: 2,
      name: "Nora",
      email: "nora@example.com",
      phone: null,
      status: "create",
      issues: [],
      matches: [],
      duplicateRow: null,
    },
    {
      row: 3,
      name: "Existing",
      email: "existing@example.com",
      phone: null,
      status: "duplicate",
      issues: [],
      matches: [{ id: "0198f5a0-7b1c-7000-8000-0000000000c1", name: "Existing profile" }],
      duplicateRow: null,
    },
  ],
};
let posts: Record<string, unknown>[];
let loseResponse: boolean;
let conflict: boolean;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  posts = [];
  loseResponse = false;
  conflict = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/admin/clients/import/preview") return response(plan);
    if (url.pathname === "/api/admin/clients/import") {
      posts.push(JSON.parse(String(init?.body)));
      if (loseResponse) {
        loseResponse = false;
        throw new TypeError("Connection lost");
      }
      if (conflict)
        return response({ error: { code: "version_conflict", message: "Directory changed" } }, 409);
      return response(
        {
          id: "0198f5a0-7b1c-7000-8000-0000000000a1",
          created: 1,
          skipped: 1,
          clientIds: ["0198f5a0-7b1c-7000-8000-0000000000c2"],
          importedAt: "2026-03-02T12:00:00.000Z",
        },
        201,
      );
    }
    return response({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
async function review() {
  renderApp(<ClientTransfer />);
  fireEvent.click(screen.getByRole("button", { name: "Import clients" }));
  fireEvent.change(screen.getByLabelText("CSV content"), { target: { value: CSV } });
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  await screen.findByRole("checkbox", { name: "Import row 2: Nora" });
}
test("review exposes duplicates and allows only clean selected rows to be imported", async () => {
  await review();
  expect(posts).toHaveLength(0);
  expect(screen.getByRole("checkbox", { name: "Import row 2: Nora" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Import row 3: Existing" })).toBeDisabled();
  expect(screen.getByText("Existing profile")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Import 1 client" }));
  await screen.findByText("Imported 1 client. Skipped 1 row.");
  expect(posts[0]).toMatchObject({ csv: CSV, reviewHash: plan.reviewHash, rows: [2] });
});
test("an uncertain response preserves the reviewed file, row selection and import identifier", async () => {
  await review();
  loseResponse = true;
  fireEvent.click(screen.getByRole("button", { name: "Import 1 client" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("CSV content")).toHaveValue(CSV);
  fireEvent.click(screen.getByRole("button", { name: "Import 1 client" }));
  await screen.findByText("Imported 1 client. Skipped 1 row.");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
});
test("edits discard the old preview and a changed directory requires a fresh review", async () => {
  await review();
  conflict = true;
  fireEvent.click(screen.getByRole("button", { name: "Import 1 client" }));
  await screen.findByText("The directory changed. Review the file again before importing.");
  expect(screen.getByRole("button", { name: "Import 1 client" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("CSV content"), {
    target: { value: "name,email\nEdited,edited@example.com" },
  });
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: "Import row 2: Nora" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "Import 1 client" })).toBeNull();
});
