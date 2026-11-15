import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { AccessPanel } from "./access-panel";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let body: unknown;
beforeEach(() => {
  body = undefined;
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") body = JSON.parse(String(init.body));
    return Response.json({
      staffId: id,
      preset: body ? "restricted" : "professional",
      version: body ? 2 : 1,
      accountRole: "staff",
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("owner chooses a staff access profile with an optimistic version", async () => {
  renderApp(<AccessPanel staffId={id} />);
  fireEvent.change(await screen.findByLabelText("Access profile"), {
    target: { value: "restricted" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save access profile" }));
  await waitFor(() => expect(body).toEqual({ preset: "restricted", version: 1 }));
});
