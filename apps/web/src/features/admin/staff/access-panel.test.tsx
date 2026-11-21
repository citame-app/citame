import { afterEach, expect, mock, test } from "bun:test";
import type { ReviewedStaffAccess } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { AccessPanel } from "./access-panel";

const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const initial: ReviewedStaffAccess = {
  generation: "initial",
  accountId: "original-staff-account",
  accountEmail: "original@example.test",
  access: { staffId, preset: "professional", version: 1, accountRole: "staff" },
};
const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});

test("owner chooses an access profile with the reviewed version", async () => {
  let body: unknown;
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") body = JSON.parse(String(init.body));
    return Response.json(
      body
        ? { ...initial, access: { ...initial.access, preset: "restricted", version: 2 } }
        : initial,
    );
  }) as unknown as typeof fetch;
  renderApp(<AccessPanel staffId={staffId} />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Access profile" }), {
    target: { value: "restricted" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save access profile" }));
  await waitFor(() =>
    expect(body).toEqual({
      preset: "restricted",
      version: 1,
      generation: initial.generation,
      accountId: initial.accountId,
    }),
  );
});

test("changing the linked team account keeps the proposed preset and requires review before publishing", async () => {
  const latest: ReviewedStaffAccess = {
    ...initial,
    accountId: "updated-staff-account",
    accountEmail: "updated@example.test",
    access: { ...initial.access, preset: "receptionist", version: 2 },
  };
  const writes: unknown[] = [];
  let current = initial;
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      current = { ...latest, access: { ...latest.access, version: 3, preset: "restricted" } };
    }
    return Response.json(current);
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(<AccessPanel staffId={staffId} />);
  const selector = await screen.findByRole("combobox", { name: "Access profile" });
  fireEvent.change(selector, { target: { value: "restricted" } });
  current = latest;
  act(() => queryClient.setQueryData(["admin", "staff-access", staffId], latest));
  const review = await screen.findByRole("button", { name: "Review current access" });
  expect(selector).toHaveValue("restricted");
  expect(screen.getByText("Linked account: updated@example.test")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("the linked account changed");
  const save = screen.getByRole("button", { name: "Save access profile" });
  expect(save).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Access profile" }));
  expect(writes).toHaveLength(0);
  fireEvent.click(review);
  fireEvent.click(save);
  await waitFor(() =>
    expect(writes).toEqual([
      {
        generation: latest.generation,
        accountId: latest.accountId,
        version: 2,
        preset: "restricted",
      },
    ]),
  );
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Access profile saved"));
});
