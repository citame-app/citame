import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type AdminService, listAdminServicesResponseSchema } from "@sob/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createRef, type Ref, useImperativeHandle, useState } from "react";
import { renderApp } from "../../../../test/render";
import { ServiceSheet, ServicesView } from "./services-view";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const CUT = "0198f5a0-7b1c-7000-8000-000000000101";
const COLOR = "0198f5a0-7b1c-7000-8000-000000000103";
const realFetch = globalThis.fetch;

type Svc = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
  staffIds: string[];
  version?: number;
};
let services: Svc[];
let calls: { method: string; path: string; body: unknown }[];
let fail: { status: number; body: unknown } | null;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function ServiceEditorFixture({
  service,
  initial,
  ref,
}: {
  service: AdminService;
  initial: AdminService[];
  ref: Ref<(rows: AdminService[]) => void>;
}) {
  const [catalogue, setCatalogue] = useState(initial);
  useImperativeHandle(ref, () => setCatalogue, []);
  return (
    <ServiceSheet
      service={service}
      catalog={catalogue}
      onClose={() => {}}
      onSaved={() => {}}
      onReload={async () => {}}
      onRelated={() => {}}
      onOpenRelated={() => {}}
    />
  );
}

test("service merchandising edits are included in the reviewed atomic submission", async () => {
  open();
  fireEvent.click(
    within(await screen.findByRole("table", { name: "Services" })).getByRole("button", {
      name: "Haircut",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Category"), { target: { value: "Hair" } });
  fireEvent.change(within(dialog).getByLabelText("Display order"), { target: { value: "2" } });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Clients can book this service online" }),
  );
  fireEvent.change(within(dialog).getByLabelText("Before your appointment"), {
    target: { value: "Bring a photo" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.body).toMatchObject({
    service: {
      category: "Hair",
      sortOrder: 2,
      onlineBooking: false,
      clientInstructions: "Bring a photo",
    },
  });
});

test("variants can be added from their parent with inherited currency and performers", async () => {
  open();
  fireEvent.click(
    within(await screen.findByRole("table", { name: "Services" })).getByRole("button", {
      name: "Haircut",
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add service variant" }));
  const dialog = await screen.findByRole("dialog", { name: "New service" });
  expect(within(dialog).getByLabelText("Catalog type")).toHaveValue("variant");
  expect(within(dialog).getByLabelText("Parent service")).toHaveValue(CUT);
  expect(within(dialog).getByLabelText("Currency (3 letters)")).toHaveValue("ARS");
  expect(within(dialog).getByRole("checkbox", { name: "Ana" })).toBeChecked();
});

test("variable prices can be created without entering a fixed amount", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "New service" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Bespoke treatment" },
  });
  fireEvent.change(within(dialog).getByLabelText("Duration (minutes)"), {
    target: { value: "60" },
  });
  fireEvent.change(within(dialog).getByLabelText("Price type"), { target: { value: "variable" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]?.body).toMatchObject({ priceType: "variable", priceCents: 0 });
});

beforeEach(() => {
  calls = [];
  fail = null;
  services = [
    {
      id: CUT,
      name: "Haircut",
      description: "Wash, cut and style",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1_500_000,
      currency: "ARS",
      active: true,
      staffIds: [ANA, BEA],
    },
    {
      id: COLOR,
      name: "Hair color",
      description: null,
      durationMinutes: 90,
      bufferMinutes: 15,
      priceCents: 4_500_000,
      currency: "ARS",
      active: false,
      staffIds: [],
    },
  ];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/admin/staff") {
      return json({
        staff: [
          { id: ANA, displayName: "Ana", active: true, userId: null, serviceIds: [] },
          { id: BEA, displayName: "Bea", active: true, userId: null, serviceIds: [] },
        ],
      });
    }
    if (url.pathname.startsWith("/api/admin/services")) {
      calls.push({ method, path: url.pathname, body });
      if (method !== "GET" && fail) return json(fail.body, fail.status);
      if (method === "GET") return json({ services });
      if (method === "POST") {
        const created = {
          id: "0198f5a0-7b1c-7000-8000-0000000001ff",
          description: null,
          bufferMinutes: 0,
          currency: "ARS",
          active: true,
          staffIds: [],
          ...body,
        };
        services = [...services, created];
        return json(created, 201);
      }
      const id = url.pathname.split("/")[4];
      const current = services.find((s) => s.id === id) as Svc;
      if (method === "PUT" && url.pathname.endsWith("/configuration")) {
        const id = url.pathname.split("/")[4];
        const current = services.find((s) => s.id === id);
        const updated = {
          ...current,
          ...body.service,
          staffIds: body.staffIds,
          version: body.version + 1,
        };
        services = services.map((s) => (s.id === id ? updated : s));
        return json(updated);
      }
      if (method === "PUT") {
        const next = { ...current, staffIds: body.staffIds };
        services = services.map((s) => (s.id === id ? next : s));
        return json(next);
      }
      if (method === "DELETE") {
        const next = { ...current, active: false };
        services = services.map((s) => (s.id === id ? next : s));
        return json(next);
      }
      const next = { ...current, ...body };
      services = services.map((s) => (s.id === id ? next : s));
      return json(next);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const writes = () => calls.filter((c) => c.method !== "GET");
const open = () => renderApp(<ServicesView />);

describe("ServicesView", () => {
  test("lists services with duration, price, team size and status", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Services" });
    const rows = within(table).getAllByRole("row");
    // sorted by name: "Hair color" precedes "Haircut"
    expect(within(rows[1] as HTMLElement).getByText("Hair color")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Inactive")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Nobody yet")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Haircut")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("2 people")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Active")).toBeInTheDocument();
  });

  test("an empty catalog invites the first service", async () => {
    services = [];
    open();
    expect(await screen.findByText("No services yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New service" }).length).toBeGreaterThan(0);
  });

  test("the create form validates with specific messages and sends nothing", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText("Enter a whole number greater than zero"),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText("This field is required").length).toBeGreaterThan(0);
    expect(writes()).toHaveLength(0);
  });

  test("an error disappears as soon as its field is corrected", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText("Enter a whole number greater than zero"),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Duration (minutes)"), {
      target: { value: "75" },
    });
    expect(within(dialog).queryByText("Enter a whole number greater than zero")).toBeNull();
    // the field that is still empty keeps its message
    expect(within(dialog).getAllByText("This field is required").length).toBeGreaterThan(0);
  });

  test("the live preview mirrors what the client will see", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "How clients see it" }));
    const preview = within(dialog).getByRole("region", { name: "How clients see it" });
    expect(within(preview).getByText("Service name")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Gel manicure" } });
    fireEvent.change(within(dialog).getByLabelText("Duration (minutes)"), {
      target: { value: "75" },
    });
    fireEvent.change(within(dialog).getByLabelText("Price"), { target: { value: "12000" } });
    expect(within(preview).getByText("Gel manicure")).toBeInTheDocument();
    expect(within(preview).getByText(/1h 15m/)).toBeInTheDocument();
    expect(within(preview).getByText(/12,000|12\.000/)).toBeInTheDocument();
  });

  test("creating posts the contract payload and then assigns the team", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Gel manicure" } });
    fireEvent.change(within(dialog).getByLabelText("Duration (minutes)"), {
      target: { value: "75" },
    });
    fireEvent.change(within(dialog).getByLabelText("Buffer after (minutes)"), {
      target: { value: "10" },
    });
    fireEvent.change(within(dialog).getByLabelText("Price"), { target: { value: "12000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Employees" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Ana" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: "POST",
      path: "/api/admin/services",
      body: {
        name: "Gel manicure",
        description: null,
        durationMinutes: 75,
        bufferMinutes: 10,
        priceCents: 1_200_000,
        currency: "ARS",
        staffIds: [ANA],
      },
    });
    expect(await screen.findByText("Service created")).toBeInTheDocument();
  });

  test("editing submits reviewed service details and the team atomically", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Services" });
    fireEvent.click(within(table).getByRole("button", { name: "Haircut" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit service" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Haircut");
    expect(within(dialog).getByLabelText("Price")).toHaveValue("15000");
    fireEvent.change(within(dialog).getByLabelText("Price"), { target: { value: "16000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: `/api/admin/services/${CUT}/configuration`,
      body: { version: 1, service: { priceCents: 1_600_000 }, staffIds: [ANA, BEA] },
    });
  });

  test("assignment refresh updates a clean team and preserves a busy editor's draft", async () => {
    const { services: initial } = listAdminServicesResponseSchema.parse({ services });
    const service = initial.find((row) => row.id === CUT);
    if (!service) throw new Error("Missing fixture service");
    const catalogue = createRef<(rows: AdminService[]) => void>();
    function replaceTeam(staffIds: string[], version: number) {
      const updated = listAdminServicesResponseSchema.parse({
        services: initial.map((row) => (row.id === CUT ? { ...row, staffIds, version } : row)),
      });
      if (!catalogue.current) throw new Error("Missing catalogue fixture control");
      act(() => catalogue.current?.(updated.services));
    }
    renderApp(<ServiceEditorFixture service={service} initial={initial} ref={catalogue} />);
    const dialog = within(await screen.findByRole("dialog", { name: "Edit service" }));
    const ana = await dialog.findByRole("checkbox", { name: "Ana" });
    const bea = dialog.getByRole("checkbox", { name: "Bea" });
    const price = dialog.getByLabelText("Price");
    fireEvent.change(price, { target: { value: "16000" } });
    expect(bea).toBeChecked();
    replaceTeam([ANA], 2);
    expect(dialog.getByRole("checkbox", { name: "Bea" })).not.toBeChecked();
    expect(price).toHaveValue("16000");
    fireEvent.click(ana);
    replaceTeam([ANA, BEA], 3);
    expect(dialog.getByRole("status")).toBeInTheDocument();
    const save = dialog.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Review updated assignments" }));
    expect(ana).not.toBeChecked();
    expect(bea).toBeChecked();
    fireEvent.click(save);
    await waitFor(() =>
      expect(writes()[0]?.body).toMatchObject({
        version: 3,
        staffIds: [BEA],
        service: { priceCents: 1_600_000 },
      }),
    );
  });

  test("closing a dirty form asks before discarding", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close panel" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard your changes?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "New service" })).toBeInTheDocument();
  });

  test("deactivating asks for confirmation, then calls the API", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Services" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Deactivate" })[0] as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Deactivate Haircut?" })).getByRole(
        "button",
        { name: "Deactivate" },
      ),
    );
    await waitFor(() =>
      expect(writes()).toEqual([
        { method: "DELETE", path: `/api/admin/services/${CUT}`, body: undefined },
      ]),
    );
    expect(await screen.findByText("Service deactivated")).toBeInTheDocument();
  });

  test("an inactive service can be activated again without a confirmation", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Services" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Activate" })[0] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toEqual([
        { method: "PATCH", path: `/api/admin/services/${COLOR}`, body: { active: true } },
      ]),
    );
  });

  test("a server failure is reported without closing the form", async () => {
    fail = { status: 500, body: { error: { code: "internal_error", message: "boom" } } };
    open();
    const table = await screen.findByRole("table", { name: "Services" });
    fireEvent.click(within(table).getByRole("button", { name: "Haircut" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit service" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Haircut 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Could not save the service/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit service" })).toBeInTheDocument();
  });
});
