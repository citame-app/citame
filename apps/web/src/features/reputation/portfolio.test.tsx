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
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save private draft" }).disabled,
    ).toBe(false),
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

test("a photo added from a service stays associated with that service and remains a private draft", async () => {
  const packets: Record<string, unknown>[] = [];
  const serviceId = "0198f5a0-7b1c-7000-8000-000000000101";
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ services: [] });
    packets.push(JSON.parse(String(init.body)));
    throw new TypeError("Fixture stops before persistence");
  }) as unknown as typeof fetch;
  renderApp(
    <PortfolioEditor
      photo={null}
      associatedService={{ id: serviceId, name: "Facial treatment" }}
      prepareFile={async () => "YWJj"}
      onSaved={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText("Treatment (optional)")).toHaveValue(serviceId));
  expect(screen.getByLabelText("Treatment (optional)")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Treatment room" } });
  fireEvent.change(screen.getByLabelText("Image description"), {
    target: { value: "Quiet treatment room with a massage table" },
  });
  fireEvent.change(screen.getByLabelText("Photo file"), {
    target: { files: [new File(["fixture"], "photo.png", { type: "image/png" })] },
  });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save private draft" }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save private draft" }));
  await screen.findByRole("alert");
  await waitFor(() => expect(packets).toHaveLength(1));
  expect(packets[0]).toMatchObject({ serviceId });
  expect(packets[0]).not.toHaveProperty("publicationConfirmed");
});
