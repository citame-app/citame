import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { UnlinkedAccountRoles } from "./unlinked-account-roles";

const email = "synthetic-account@example.test";
const staffId = "0198f5a0-7b1c-7000-8000-000000000203";
const clientId = "0198f5a0-7b1c-7000-8000-000000000204";
const account = {
  userId: "synthetic-account",
  email,
  name: "Synthetic account",
  role: "client",
  generation: "initial",
  revision: "a".repeat(64),
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.each([true, false])("role review respects email verification (%s)", async (verified) => {
  const requests: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ userId: account.userId, role: "staff", staffId, clientId });
    }
    return Response.json({ ...account, emailVerified: verified });
  }) as unknown as typeof fetch;
  const openMember = mock((_id: string) => {});
  renderApp(<UnlinkedAccountRoles onOpenMember={openMember} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Exact account email" }), {
    target: { value: email.toUpperCase() },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find account" }));
  expect(await screen.findByText("Account role: Client")).toBeInTheDocument();
  if (!verified) {
    expect(screen.queryByRole("combobox", { name: "New account role" })).toBeNull();
    expect(requests).toEqual([]);
    return;
  }
  fireEvent.change(screen.getByRole("combobox", { name: "New account role" }), {
    target: { value: "staff" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review role change" }));
  const dialog = within(await screen.findByRole("dialog"));
  await waitFor(() => expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus());
  expect(requests).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "Confirm role change" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open staff calendar settings" }));
  expect(openMember).toHaveBeenCalledWith(staffId);
  expect(requests).toEqual([
    {
      userId: account.userId,
      generation: account.generation,
      revision: account.revision,
      role: "staff",
    },
  ]);
});
