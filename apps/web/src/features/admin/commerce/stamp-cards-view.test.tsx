import { afterEach, expect, mock, test } from "bun:test";
import type { StampCard, StampProgramTerms } from "@sob/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { StampCardsView } from "./stamp-cards-view";
import { StampProgramForm } from "./stamp-program-form";

const originalFetch = globalThis.fetch;
const program: StampProgramTerms = {
  enabled: true,
  name: "Colour card",
  appearance: "mint",
  goal: 2,
  welcomeStamps: 0,
  qualifyingServiceIds: [],
  minimumSpendCents: 2500,
  stampExpiryDays: 90,
  expiryFrom: "activity",
  rewardExpiryDays: 30,
  automaticIssue: true,
  awardOn: "checkout",
  terms: "One stamp per eligible treatment.",
  reward: {
    name: "Colour treatment discount",
    kind: "service",
    targetId: null,
    discountBasisPoints: 5000,
  },
};
const clientId = "019a0000-0000-7000-8000-000000000001";
const date = "2026-11-10T10:00:00.000Z";
const card: StampCard = {
  id: "019a0000-0000-7000-8000-000000000002",
  version: 5,
  programVersion: 2,
  program,
  stamps: 2,
  state: "completed",
  needsReview: false,
  createdAt: date,
  stampExpiresAt: null,
  rewardExpiresAt: null,
  completedAt: date,
  rewardIssuedAt: null,
  redeemedAt: null,
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("customers see card progress and their reward without operator actions", async () => {
  const read = mock(async (_input: RequestInfo | URL) => Response.json({ cards: [card] }));
  globalThis.fetch = read as unknown as typeof fetch;
  renderApp(<StampCardsView mode="client" role="client" />);
  expect(await screen.findByText("2 of 2 stamps")).toBeVisible();
  expect(screen.getByText("Colour treatment discount")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Issue reward" })).not.toBeInTheDocument();
  expect(String(read.mock.calls[0]?.[0])).toContain("/me/loyalty-cards");
});

test("issuing a reward requires explicit confirmation and the reviewed card version", async () => {
  const sent: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ ...card, version: 6, state: "issued", rewardIssuedAt: date });
    }
    return Response.json({
      cards: [card],
      generation: "test-generation",
      programVersion: 2,
      program,
    });
  }) as unknown as typeof fetch;
  renderApp(<StampCardsView mode="admin" role="owner" clientId={clientId} />);
  fireEvent.click(await screen.findByRole("button", { name: "Issue reward" }));
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(sent).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(sent[0]).toMatchObject({
      version: 5,
      generation: "test-generation",
      type: "issue_reward",
    }),
  );
});

test("invalidating prior cards shows the consequences before saving the programme", async () => {
  const sent: unknown[] = [];
  const current = { generation: "test-generation", version: 2, program };
  globalThis.fetch = mock(async (url, init) => {
    if (String(url).includes("/services")) return Response.json({ services: [] });
    if (init?.method === "PUT") {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ ...current, version: 3 });
    }
    return Response.json(current);
  }) as unknown as typeof fetch;
  renderApp(<StampProgramForm />);
  fireEvent.change(await screen.findByLabelText("Previously issued cards"), {
    target: { value: "void" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(
    await screen.findByText("Any unredeemed card from a previous version will become void."),
  ).toBeVisible();
  expect(sent).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Save programme" }));
  await waitFor(() => expect(sent[0]).toMatchObject({ version: 2, existingCards: "void" }));
});
