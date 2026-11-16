import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { PortfolioEditor } from "./portfolio-editor";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("portfolio upload keeps an uncertain image and exact request for retry and never publishes implicitly", async () => {
  const packets: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ services: [] });
    packets.push(JSON.parse(String(init.body)));
    throw new TypeError("Lost response");
  }) as unknown as typeof fetch;
  renderApp(
    <PortfolioEditor
      photo={null}
      prepareFile={async () => "YWJj"}
      onSaved={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Finished style" } });
  fireEvent.change(screen.getByLabelText("Image description"), {
    target: { value: "Hair viewed from behind" },
  });
  fireEvent.change(screen.getByLabelText("Photo file"), {
    target: { files: [new File(["fixture"], "photo.png", { type: "image/png" })] },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save private draft" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save private draft" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Caption")).toHaveValue("Finished style");
  expect(screen.getByLabelText("Caption")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save private draft" }));
  await waitFor(() => expect(packets).toHaveLength(2));
  expect(packets[1]).toEqual(packets[0]);
  expect(packets[0]).toMatchObject({ caption: "Finished style", imageBase64: "YWJj" });
  expect(packets[0]).not.toHaveProperty("publicationConfirmed");
});
