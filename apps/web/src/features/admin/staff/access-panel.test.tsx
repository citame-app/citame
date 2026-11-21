import { afterEach, expect, mock, test } from "bun:test";
import type { ReviewedStaffAccess } from "@sob/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

test.each(["current", "changed", "self"] as const)(
  "the Web role confirmation respects a %s account review",
  async (scenario) => {
    const writes: unknown[] = [];
    let latest = initial;
    globalThis.fetch = mock(async (_input, init) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        latest = { ...initial, access: { ...initial.access, version: 2, accountRole: "client" } };
      }
      return Response.json(latest);
    }) as unknown as typeof fetch;
    const { queryClient } = renderApp(
      <AccessPanel
        staffId={staffId}
        staffName="Ana"
        actorUserId={scenario === "self" ? (initial.accountId ?? "") : "reviewing-owner"}
      />,
    );
    await screen.findByText("Linked account: original@example.test");
    if (scenario === "self") {
      expect(screen.queryByRole("button", { name: "Review role change" })).not.toBeInTheDocument();
      return;
    }
    fireEvent.change(screen.getByRole("combobox", { name: "New account role" }), {
      target: { value: "client" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review role change" }));
    const dialog = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus());
    const confirm = dialog.getByRole("button", { name: "Confirm role change" });
    if (scenario === "changed") {
      await act(async () => {
        queryClient.setQueryData(["admin", "staff-access", staffId], {
          ...initial,
          accountId: "changed-account",
          access: { ...initial.access, version: 2 },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(confirm).toBeDisabled();
      expect(writes).toEqual([]);
      return;
    }
    fireEvent.click(confirm);
    expect(await screen.findByText("Account role changed")).toBeInTheDocument();
    expect(writes).toEqual([
      {
        generation: "initial",
        accountId: initial.accountId,
        expectedRole: "staff",
        version: 1,
        role: "client",
      },
    ]);
  },
);

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
  renderApp(<AccessPanel staffId={staffId} staffName="Ana" />);
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
  const { queryClient } = renderApp(<AccessPanel staffId={staffId} staffName="Ana" />);
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

test("invitations link to the reviewed existing calendar and show the linked account", async () => {
  let current = {
    ...initial,
    accountId: null,
    accountEmail: null,
    access: { ...initial.access, accountRole: null },
  } as ReviewedStaffAccess;
  const writes: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      current = { ...initial, access: { ...initial.access, version: 2 } };
      return Response.json(
        {
          userId: current.accountId,
          email: current.accountEmail,
          staffId,
          role: "staff",
          reviewedAccess: current,
          invited: true,
        },
        { status: 201 },
      );
    }
    return Response.json(current);
  }) as unknown as typeof fetch;
  renderApp(<AccessPanel staffId={staffId} staffName="Ana" />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: initial.accountEmail },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue email invitation" }));
  expect(
    await screen.findByText("Invitation queued. They will set their own password."),
  ).toBeInTheDocument();
  expect(screen.getByText("Linked account: original@example.test")).toBeInTheDocument();
  expect(writes).toEqual([
    {
      name: "Ana",
      email: initial.accountEmail,
      existingCalendar: { staffId, version: 1, generation: "initial" },
    },
  ]);
});
