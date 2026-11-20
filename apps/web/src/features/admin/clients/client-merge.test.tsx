import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientMerge } from "./client-merge";

const ROOT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const SOURCE = "0198f5a0-7b1c-7000-8000-0000000000c2";
const originalFetch = globalThis.fetch;
const profile = (id: string, name: string) => ({
  id,
  name,
  email: `${name}@example.invalid`,
  phone: null,
  notes: "Private original note",
  tags: [],
  bookingAccess: "normal",
  hasAccount: id === ROOT,
  profileCount: 1,
});
const plan = {
  reviewHash: "a".repeat(64),
  canMerge: true,
  reasons: [],
  source: profile(SOURCE, "Original"),
  target: profile(ROOT, "Survivor"),
  counts: { profiles: 2, appointments: 3, receipts: 2, photos: 1, forms: 1, passes: 1, gifts: 0 },
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let packets: Record<string, unknown>[];
let outcomes: ("lost" | "auth" | "stale")[];
beforeEach(() => {
  packets = [];
  outcomes = [];
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/duplicates"))
        return reply({
          candidates: [{ ...profile(SOURCE, "Original"), matchedBy: ["email"] }],
          hasMore: false,
        });
      if (url.pathname.endsWith("/merge/preview")) return reply(plan);
      if (url.pathname.endsWith("/merge")) {
        packets.push(JSON.parse(String(init?.body)));
        const outcome = outcomes.shift();
        if (outcome === "lost") throw new TypeError("Lost response");
        if (outcome === "auth")
          return reply({ error: { code: "unauthorized", message: "Sign in again" } }, 401);
        if (outcome === "stale")
          return reply({ error: { code: "version_conflict", message: "Contacts changed" } }, 409);
        return reply(
          {
            id: "0198f5a0-7b1c-7000-8000-0000000000f1",
            sourceId: SOURCE,
            targetId: ROOT,
            createdAt: "2026-11-16T12:00:00Z",
          },
          201,
        );
      }
      if (url.pathname.endsWith("/clients"))
        return reply({ clients: [], page: 1, pageSize: 20, total: 0 });
      throw new Error(`Unexpected request ${url.pathname}`);
    }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
async function review() {
  renderApp(<ClientMerge clientId={ROOT} clientName="Survivor" />);
  fireEvent.click(screen.getByRole("button", { name: "Review duplicate profiles" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Original/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review identity link" }));
  await screen.findByText(
    "Original appointments: 3 · Receipts: 2 · Photos: 1 · Forms: 1 · Passes: 1 · Gifts: 0",
  );
}
test("a fresh two-profile review requires explicit same-person confirmation", async () => {
  await review();
  const submit = screen.getByRole("button", { name: "Join these profiles" });
  expect(submit).toBeDisabled();
  expect(packets).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: /I have verified/ }));
  fireEvent.click(submit);
  await screen.findByText("Profiles joined. Original history and financial records are preserved.");
  expect(packets[0]).toMatchObject({
    sourceId: SOURCE,
    targetId: ROOT,
    reviewHash: plan.reviewHash,
    confirmedSamePerson: true,
  });
});
test("an uncertain merge stays frozen through a later authentication failure and replays its original packet", async () => {
  await review();
  outcomes = ["lost", "auth"];
  fireEvent.click(screen.getByRole("checkbox", { name: /I have verified/ }));
  fireEvent.click(screen.getByRole("button", { name: "Join these profiles" }));
  await screen.findByText(
    "The result is uncertain. Recover this same request before starting another merge.",
  );
  expect(screen.getByRole("checkbox", { name: /I have verified/ })).toBeDisabled();
  expect(screen.getByLabelText("Search another profile")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover this merge" }));
  await waitFor(() => expect(packets).toHaveLength(2));
  const login = await screen.findByRole("link", { name: "Sign in again in another tab" });
  expect(login).toHaveAttribute("target", "_blank");
  expect(login).toHaveAttribute("rel", "noopener");
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Recover this merge" }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Recover this merge" }));
  await screen.findByText("Profiles joined. Original history and financial records are preserved.");
  expect(packets).toHaveLength(3);
  expect(packets[1]).toEqual(packets[0]);
  expect(packets[2]).toEqual(packets[0]);
});
test("changed contacts require another preview and another confirmation", async () => {
  await review();
  outcomes = ["stale"];
  fireEvent.click(screen.getByRole("checkbox", { name: /I have verified/ }));
  fireEvent.click(screen.getByRole("button", { name: "Join these profiles" }));
  await screen.findByText("The profiles changed. Review them again before confirming.");
  expect(screen.queryByRole("checkbox", { name: /I have verified/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review identity link" }));
  await screen.findByRole("checkbox", { name: /I have verified/ });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review identity link" }));
  await screen.findByRole("checkbox", { name: /I have verified/ });
  expect(screen.getByRole("button", { name: "Join these profiles" })).toBeDisabled();
});
test("unsaved profile edits prevent starting a merge", () => {
  renderApp(<ClientMerge clientId={ROOT} clientName="Survivor" disabled />);
  expect(screen.getByRole("button", { name: "Review duplicate profiles" })).toBeDisabled();
});
