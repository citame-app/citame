import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientsView } from "./clients-view";
import type { ClientsSearch } from "./search";

const realFetch = globalThis.fetch;
const mk = (n: number, name: string, extra: Record<string, unknown> = {}) => ({
  id: `0198f5a0-7b1c-7000-8000-0000000000c${n}`,
  name,
  phone: `+54 9 11 5555-000${n}`,
  email: `${name.toLowerCase()}@example.com`,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  appointmentCount: n,
  lastVisitAt: n === 1 ? "2026-03-01T15:00:00.000Z" : null,
  ...extra,
});

let urls: string[];
let all: ReturnType<typeof mk>[];
let failing = false;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  urls = [];
  failing = false;
  all = [mk(1, "Ana"), mk(2, "Bea")];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url.pathname + url.search);
    if (url.pathname === "/api/admin/clients/groups")
      return json({ groups: [{ name: "vip", count: 3 }] });
    if (failing) return json({}, 500);
    if (url.pathname === "/api/admin/clients") {
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      const clients = all.filter((c) => c.name.toLowerCase().includes(q));
      return json({
        clients,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: 20,
        total: q === "" && all.length === 2 ? 45 : clients.length,
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base: ClientsSearch = { page: 2, sort: "name", order: "asc" };
const open = (
  search: ClientsSearch = base,
  onSearchChange: (s: ClientsSearch) => void = () => {},
  onOpen: (id: string) => void = () => {},
) =>
  renderApp(<ClientsView search={search} onSearchChange={onSearchChange} onOpenClient={onOpen} />);

describe("ClientsView", () => {
  test("queries the API with the URL state: page, sort, order, search", async () => {
    open({ q: "an", page: 2, sort: "lastVisitAt", order: "desc" });
    await screen.findByRole("table", { name: "Clients" });
    const params = urls
      .map((u) => new URL(u, "http://x"))
      .find((u) => u.pathname === "/api/admin/clients")?.searchParams;
    expect(Object.fromEntries(params ?? [])).toEqual({
      page: "2",
      pageSize: "20",
      search: "an",
      sort: "lastVisitAt",
      order: "desc",
    });
  });

  test("renders the rows with contact data and a never-visited marker", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(within(table).getByText("ana@example.com")).toBeInTheDocument();
    expect(within(table).getByText("No visits yet")).toBeInTheDocument();
  });

  test("sorting a column sends the user back to page 1 with that sort", async () => {
    const onSearchChange = mock();
    open(base, onSearchChange);
    await screen.findByRole("table", { name: "Clients" });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Last visit" }));
    expect(onSearchChange).toHaveBeenCalledWith({ page: 1, sort: "lastVisitAt", order: "asc" });
  });

  test("changing the page keeps the other state", async () => {
    const onSearchChange = mock();
    open(base, onSearchChange);
    await screen.findByRole("table", { name: "Clients" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onSearchChange).toHaveBeenCalledWith({ page: 3, sort: "name", order: "asc" });
  });

  test("typing in the search box updates the URL state after a pause and resets the page", async () => {
    const onSearchChange = mock();
    open(base, onSearchChange);
    fireEvent.change(await screen.findByLabelText("Search clients"), { target: { value: "bea" } });
    await waitFor(() =>
      expect(onSearchChange).toHaveBeenCalledWith({
        q: "bea",
        page: 1,
        sort: "name",
        order: "asc",
      }),
    );
  });

  test("opening a row reports the client id", async () => {
    const onOpen = mock();
    open(base, () => {}, onOpen);
    const table = await screen.findByRole("table", { name: "Clients" });
    fireEvent.click(within(table).getByRole("button", { name: "Ana" }));
    expect(onOpen).toHaveBeenCalledWith("0198f5a0-7b1c-7000-8000-0000000000c1");
  });

  test("an empty directory invites the first booking", async () => {
    all = [];
    open({ page: 1, sort: "name", order: "asc" });
    expect(await screen.findByText("No clients yet")).toBeInTheDocument();
  });

  test("a search without results offers to clear it", async () => {
    const onSearchChange = mock();
    open({ q: "zzz", page: 1, sort: "name", order: "asc" }, onSearchChange);
    expect(await screen.findByText('No clients match "zzz"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearchChange).toHaveBeenCalledWith({ page: 1, sort: "name", order: "asc" });
  });

  test("a failure shows an error with retry", async () => {
    failing = true;
    open();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  test("groups open independently and selecting a group clears the previous name search", async () => {
    failing = true;
    const onSearchChange = mock();
    open({ ...base, q: "bea" }, onSearchChange);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Client groups" }));
    fireEvent.click(await screen.findByRole("button", { name: "vip 3" }));
    expect(onSearchChange).toHaveBeenCalledWith({ ...base, group: "vip", page: 1 });
    expect(screen.getByRole("searchbox", { name: "Search clients" })).toHaveValue("");
  });
});
