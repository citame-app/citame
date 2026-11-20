import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ServiceResources } from "@sob/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ResourcesPanel } from "./resources-panel";

const ID = "0198f5a0-7b1c-7000-8000-000000000101";
const SERVICE = "0198f5a0-7b1c-7000-8000-000000000102";
const original = globalThis.fetch;
let writes: { path: string; body: Record<string, unknown> }[];
let failure: boolean;
let currentRequirements: ServiceResources;
const pool = {
  id: ID,
  name: "Room A",
  kind: "room",
  capacity: 2,
  active: true,
  version: 1,
  createdAt: "2026-03-02T12:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  writes = [];
  failure = false;
  currentRequirements = { serviceId: SERVICE, version: 1, requirements: [] };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method && init.method !== "GET") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (failure) return json({ error: { code: "version_conflict", message: "Changed" } }, 409);
      if (path.endsWith("/resources") && path.includes("/services/")) {
        currentRequirements = {
          serviceId: SERVICE,
          version: body.version + 1,
          selectionMode: body.selectionMode ?? currentRequirements.selectionMode,
          requirements: body.requirements.map((r: { resourceId: string; quantity: number }) => ({
            ...r,
            name: pool.name,
            capacity: pool.capacity,
            active: true,
          })),
        };
        return json(currentRequirements);
      }
      return json({ ...pool, ...body, version: 2 }, init.method === "POST" ? 201 : 200);
    }
    if (path === "/api/admin/resources") return json({ resources: [pool] });
    if (path === `/api/admin/services/${SERVICE}/resources`) return json(currentRequirements);
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});
async function open() {
  renderApp(<ResourcesPanel services={[{ id: SERVICE, name: "Facial" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Rooms & equipment" }));
  await screen.findByRole("button", { name: "Edit Room A" });
}
test("creates a bounded resource and preserves the creation key when retrying the same draft", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "New resource" }));
  fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "Room B" } });
  fireEvent.change(screen.getByLabelText("Available units"), { target: { value: "21" } });
  fireEvent.click(screen.getByRole("button", { name: "Save resource" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1 to 20");
  expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Available units"), { target: { value: "2" } });
  failure = true;
  fireEvent.click(screen.getByRole("button", { name: "Save resource" }));
  await screen.findByRole("button", { name: "Reload current settings" });
  expect(screen.getByLabelText("Resource name")).toHaveValue("Room B");
  failure = false;
  fireEvent.click(screen.getByRole("button", { name: "Save resource" }));
  await screen.findByText("Resource saved");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body.idempotencyKey).toBe(writes[1]?.body.idempotencyKey);
});
test("retains an edited resource on conflict and reloads only at the operator's request", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit Room A" }));
  fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "Renamed" } });
  failure = true;
  fireEvent.click(screen.getByRole("button", { name: "Save resource" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload current settings" }));
  await waitFor(() => expect(screen.getByLabelText("Resource name")).toHaveValue("Room A"));
  expect(writes[0]?.body).toMatchObject({ version: 1, name: "Renamed" });
});
test("service requirements validate quantity against capacity and send the reviewed revision", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Service resources"), { target: { value: SERVICE } });
  const quantity = await screen.findByLabelText("Units of Room A");
  fireEvent.change(quantity, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("capacity");
  expect(writes).toHaveLength(0);
  fireEvent.change(quantity, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
  await screen.findByText("Requirements saved");
  expect(writes[0]?.body).toEqual({ version: 1, requirements: [{ resourceId: ID, quantity: 1 }] });
});
test("selecting one available resource shows options and saves the selected mode", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Service resources"), { target: { value: SERVICE } });
  fireEvent.click(await screen.findByRole("radio", { name: "Use one available resource" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Room A" }));
  fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
  await screen.findByText("Requirements saved");
  expect(writes[0]?.body).toEqual({
    version: 1,
    selectionMode: "one_of",
    requirements: [{ resourceId: ID, quantity: 1 }],
  });
  expect(screen.getByRole("checkbox", { name: "Room A" })).toBeChecked();
});
test("closing a dirty resource draft requires explicit discard", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit Room A" }));
  fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(
    await screen.findByRole("dialog", { name: "Discard resource changes?" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Resource name")).toHaveValue("Unsaved");
  expect(writes).toHaveLength(0);
});

test("reloading requirements refreshes a resource capacity changed by another operator", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Service resources"), { target: { value: SERVICE } });
  fireEvent.change(await screen.findByLabelText("Units of Room A"), { target: { value: "2" } });
  failure = true;
  fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
  await screen.findByRole("button", { name: "Reload current settings" });
  pool.capacity = 1;
  failure = false;
  try {
    fireEvent.click(screen.getByRole("button", { name: "Reload current settings" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Units of Room A")).toHaveAttribute("max", "1"),
    );
    expect(screen.getByLabelText("Units of Room A")).toHaveValue(0);
  } finally {
    pool.capacity = 2;
  }
});

test("saved requirements remain visible after closing and reopening the panel", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Service resources"), { target: { value: SERVICE } });
  fireEvent.change(await screen.findByLabelText("Units of Room A"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));
  await screen.findByText("Requirements saved");
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  fireEvent.click(screen.getByRole("button", { name: "Rooms & equipment" }));
  fireEvent.change(await screen.findByLabelText("Service resources"), {
    target: { value: SERVICE },
  });
  await waitFor(() => expect(screen.getByLabelText("Units of Room A")).toHaveValue(1));
});
