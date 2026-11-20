import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { AdminService } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ServicesView } from "./services-view";

const CUT = "0198f5a0-7b1c-7000-8000-000000000101";
const VAR = "0198f5a0-7b1c-7000-8000-000000000102";
const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const oldFetch = globalThis.fetch;
let rows: AdminService[];
let writes: { path: string; body: Record<string, unknown> }[];
let fail = false;
beforeEach(() => {
  writes = [];
  fail = false;
  rows = [
    {
      id: CUT,
      name: "Haircut",
      description: null,
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 2000,
      currency: "EUR",
      active: true,
      staffIds: [ANA],
      version: 1,
    },
  ];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/admin/staff")
      return reply({
        staff: [{ id: ANA, displayName: "Ana", active: true, userId: null, serviceIds: [CUT] }],
      });
    if (init?.method && init.method !== "GET") {
      writes.push({ path, body });
      if (fail) return reply({ error: { code: "version_conflict", message: "Changed" } }, 409);
      if (init.method === "POST") {
        const catalog = body.catalog ? { ...body.catalog, version: 1 } : undefined;
        const created = { ...rows[0], ...body, id: VAR, catalog, staffIds: body.staffIds ?? [ANA] };
        rows.push(created);
        return reply(created, 201);
      }
      if (path.endsWith("/configuration")) {
        const updated = {
          ...rows[1],
          ...body.service,
          staffIds: body.staffIds,
          version: 2,
          catalog: { ...body.catalog, version: 2 },
        };
        rows[1] = updated;
        return reply(updated);
      }
    }
    if (path === "/api/admin/services") return reply({ services: rows });
    return reply({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = oldFetch;
});
async function createForm() {
  renderApp(<ServicesView />);
  fireEvent.click(await screen.findByRole("button", { name: "New service" }));
  return within(screen.getByRole("dialog", { name: "New service" }));
}
test("creates a priced variant and its selected team with one atomic request", async () => {
  const form = await createForm();
  fireEvent.change(form.getByLabelText("Catalog type"), { target: { value: "variant" } });
  fireEvent.change(form.getByLabelText("Parent service"), { target: { value: CUT } });
  fireEvent.change(form.getByLabelText("Variant label"), { target: { value: "Long hair" } });
  expect(form.getByLabelText("Name")).toHaveValue("Haircut · Long hair");
  fireEvent.change(form.getByLabelText("Duration (minutes)"), { target: { value: "60" } });
  fireEvent.change(form.getByLabelText("Price"), { target: { value: "30" } });
  fireEvent.click(form.getByRole("button", { name: "Create" }));
  await screen.findByText("Service created");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toMatchObject({
    name: "Haircut · Long hair",
    currency: "EUR",
    durationMinutes: 60,
    priceCents: 3000,
    staffIds: [ANA],
    catalog: { kind: "variant", parentServiceId: CUT, optionLabel: "Long hair" },
  });
});
test("a zero-time extra needs explicit eligible services before it can be saved", async () => {
  const form = await createForm();
  fireEvent.change(form.getByLabelText("Catalog type"), { target: { value: "addon" } });
  fireEvent.change(form.getByLabelText("Name"), { target: { value: "Finish" } });
  fireEvent.change(form.getByLabelText("Price"), { target: { value: "5" } });
  fireEvent.click(form.getByRole("button", { name: "Create" }));
  expect(writes).toHaveLength(0);
  expect(form.getByRole("alert")).toHaveTextContent("eligible service");
  fireEvent.click(
    within(form.getByRole("group", { name: "Eligible services" })).getByRole("checkbox", {
      name: "Haircut",
    }),
  );
  fireEvent.click(form.getByRole("button", { name: "Create" }));
  await screen.findByText("Service created");
  expect(writes[0]?.body).toMatchObject({
    durationMinutes: 0,
    bufferMinutes: 0,
    catalog: { kind: "addon", allowedServiceIds: [CUT] },
  });
});
test("a conflict keeps the whole edit draft and offers explicit reload of the current service", async () => {
  const original = rows[0];
  if (!original) throw new Error("Missing service fixture");
  rows.push({
    ...original,
    id: VAR,
    name: "Haircut · Long hair",
    catalog: { kind: "variant", version: 1, parentServiceId: CUT, optionLabel: "Long hair" },
  });
  renderApp(<ServicesView />);
  const [edit] = await screen.findAllByRole("button", { name: "Haircut · Long hair" });
  if (!edit) throw new Error("Missing edit control");
  fireEvent.click(edit);
  const form = within(screen.getByRole("dialog", { name: "Edit service" }));
  fireEvent.change(form.getByLabelText("Variant label"), { target: { value: "My draft" } });
  fail = true;
  fireEvent.click(form.getByRole("button", { name: "Save changes" }));
  const reload = await form.findByRole("button", { name: "Reload current service" });
  expect(form.getByLabelText("Variant label")).toHaveValue("My draft");
  rows[1] = {
    ...original,
    id: VAR,
    version: 2,
    catalog: { kind: "variant", version: 2, parentServiceId: CUT, optionLabel: "Current label" },
  };
  fireEvent.click(reload);
  await waitFor(() => expect(screen.getByLabelText("Variant label")).toHaveValue("Current label"));
});

test("a variant starts from its saved parent and unsaved parent edits cannot be discarded by adding another option", async () => {
  renderApp(<ServicesView />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Haircut" }))[0]!);
  let form = within(screen.getByRole("dialog", { name: "Edit service" }));
  fireEvent.change(form.getByLabelText("Name"), { target: { value: "Draft haircut" } });
  expect(form.getByRole("button", { name: "Add service variant" })).toBeDisabled();
  fireEvent.change(form.getByLabelText("Name"), { target: { value: "Haircut" } });
  fireEvent.click(form.getByRole("button", { name: "Add service variant" }));
  form = within(await screen.findByRole("dialog", { name: "New service" }));
  expect(form.getByLabelText("Catalog type")).toHaveValue("variant");
  expect(form.getByLabelText("Parent service")).toHaveValue(CUT);
  fireEvent.change(form.getByLabelText("Variant label"), { target: { value: "Long hair" } });
  fireEvent.click(form.getByRole("button", { name: "Create" }));
  await screen.findByText("Service created");
  expect(writes[0]?.body).toMatchObject({
    name: "Haircut · Long hair",
    durationMinutes: 45,
    priceCents: 2000,
    staffIds: [ANA],
    catalog: { kind: "variant", parentServiceId: CUT, optionLabel: "Long hair" },
  });
});
