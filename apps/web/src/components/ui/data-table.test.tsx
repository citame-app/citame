import { describe, expect, mock, test } from "bun:test";
import { createColumnHelper } from "@tanstack/react-table";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { DataTable, type DataTableFeatures } from "./data-table";

interface Row {
  id: string;
  name: string;
  visits: number;
}
const helper = createColumnHelper<DataTableFeatures, Row>();
const columns = helper.columns([
  helper.accessor("name", { header: "Name", meta: { cardTitle: true } }),
  helper.accessor("visits", { header: "Visits", enableSorting: false }),
]);
const rows: Row[] = [
  { id: "1", name: "Ana", visits: 3 },
  { id: "2", name: "Bea", visits: 5 },
];

const base = {
  columns,
  data: rows,
  getRowId: (r: Row) => r.id,
  total: 45,
  page: 2,
  pageSize: 20,
  sorting: [{ id: "name", desc: false }],
  onSortingChange: () => {},
  onPageChange: () => {},
  label: "Clients",
};

describe("DataTable", () => {
  test("renders a table with column headers and rows", () => {
    renderApp(<DataTable {...base} />);
    const table = screen.getByRole("table", { name: "Clients" });
    expect(within(table).getByRole("columnheader", { name: /Name/ })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "Bea" })).toBeInTheDocument();
  });

  test("the sorted column announces its direction through aria-sort", () => {
    renderApp(<DataTable {...base} />);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /Visits/ })).not.toHaveAttribute("aria-sort");
  });

  test("clicking a sortable header asks for the opposite direction, unsortable ones are plain text", () => {
    const onSortingChange = mock();
    renderApp(<DataTable {...base} onSortingChange={onSortingChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(onSortingChange).toHaveBeenCalledWith([{ id: "name", desc: true }]);
    expect(screen.queryByRole("button", { name: "Sort by Visits" })).toBeNull();
  });

  test("paginates on the server: shows the range and calls back with the page", () => {
    const onPageChange = mock();
    renderApp(<DataTable {...base} onPageChange={onPageChange} />);
    expect(screen.getByText("Showing 21-40 of 45")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  test("the first page cannot go back, the last cannot go forward", () => {
    const { unmount } = renderApp(<DataTable {...base} page={1} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    unmount();
    renderApp(<DataTable {...base} page={3} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  test("on small screens the same rows are a list of cards titled by the marked column", () => {
    renderApp(<DataTable {...base} />);
    const list = screen.getByRole("list", { name: "Clients" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Ana")).toBeInTheDocument();
  });

  test("columns can be hidden from the column menu", async () => {
    renderApp(<DataTable {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Visits" }));
    expect(screen.queryByRole("columnheader", { name: /Visits/ })).toBeNull();
  });

  test("shows the empty message instead of rows", () => {
    renderApp(<DataTable {...base} data={[]} total={0} page={1} empty={<p>No clients yet</p>} />);
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("shows skeleton rows while loading", () => {
    renderApp(<DataTable {...base} data={[]} loading />);
    expect(screen.getByRole("status", { name: "Loading rows" })).toBeInTheDocument();
  });

  test("clicking a row reports it", () => {
    const onRowOpen = mock();
    renderApp(<DataTable {...base} onRowOpen={onRowOpen} />);
    // The table and the card list both exist; CSS shows one of them per viewport.
    const [first] = screen.getAllByRole("button", { name: "Ana" });
    fireEvent.click(first as HTMLElement);
    expect(onRowOpen).toHaveBeenCalledWith(rows[0]);
  });
});
