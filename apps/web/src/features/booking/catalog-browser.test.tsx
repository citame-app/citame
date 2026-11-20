import { expect, test } from "bun:test";
import type { Service, Staff } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { CatalogBrowser } from "./catalog-browser";
import { canPlanVisit } from "./visit-selection";

const base = {
  description: null,
  durationMinutes: 30,
  bufferMinutes: 0,
  priceCents: 2000,
  currency: "EUR",
};
const catalog: Service[] = [
  { ...base, id: "cut", name: "Corté", category: "Hair", sortOrder: 2 },
  { ...base, id: "dry", name: "Blow dry", category: "Hair", sortOrder: 1 },
  { ...base, id: "nails", name: "Manicure", category: "Nails" },
];
const staff: Staff[] = [
  { id: "ana", displayName: "Ana", serviceIds: ["cut", "dry"] },
  { id: "bea", displayName: "Bea", serviceIds: ["nails"] },
];
test("separate qualified professionals can cover a visit but not orphan extras or unqualified services", () => {
  expect(canPlanVisit(["cut", "nails"], catalog, staff)).toBe(true);
  expect(canPlanVisit(["cut", "nails"], catalog, staff.slice(0, 1))).toBe(false);
  expect(canPlanVisit(["unknown"], catalog, staff)).toBe(false);
});
function Harness() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <CatalogBrowser catalog={catalog} staff={staff} selected={selected} onChange={setSelected} />
      <output aria-label="Selection">{selected.join(",")}</output>
    </>
  );
}
test("category and accent-insensitive search keep selected services while browsing", () => {
  renderApp(<Harness />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Corté" }));
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Nails" } });
  expect(screen.queryByRole("checkbox", { name: "Corté" })).toBeNull();
  expect(screen.getByLabelText("Selection")).toHaveTextContent("cut");
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search services" }), {
    target: { value: "corte" },
  });
  expect(screen.getByRole("checkbox", { name: "Corté" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "Manicure" })).toBeNull();
});
test("incompatible choices explain the constraint before continuing and recover after removal", () => {
  renderApp(<Harness />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Corté" }));
  expect(screen.getByRole("checkbox", { name: "Manicure" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Manicure" })).toHaveAccessibleDescription(
    /same professional/,
  );
  expect(screen.getByRole("checkbox", { name: "Blow dry" })).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Corté" }));
  expect(screen.getByRole("checkbox", { name: "Manicure" })).toBeEnabled();
});
test("search has an actionable empty state and category order is respected", () => {
  renderApp(<Harness />);
  expect(screen.getAllByRole("checkbox").map((e) => e.getAttribute("aria-label"))).toEqual([
    "Blow dry",
    "Corté",
    "Manicure",
  ]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unknown" } });
  expect(screen.getByText("No matching services")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("checkbox", { name: "Manicure" })).toBeVisible();
});
