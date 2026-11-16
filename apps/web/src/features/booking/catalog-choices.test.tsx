import { expect, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { CatalogChoices } from "./catalog-choices";

const base = {
  id: "cut",
  name: "Haircut",
  description: null,
  durationMinutes: 45,
  bufferMinutes: 15,
  priceCents: 2000,
  currency: "EUR",
} satisfies Service;
const catalog: Service[] = [
  base,
  {
    ...base,
    id: "long",
    name: "Haircut · Long",
    priceCents: 3000,
    catalog: { kind: "variant", version: 1, parentServiceId: "cut", optionLabel: "Long" },
  },
  {
    ...base,
    id: "care",
    name: "Conditioning",
    priceCents: 500,
    durationMinutes: 0,
    bufferMinutes: 0,
    catalog: { kind: "addon", version: 1, allowedServiceIds: ["cut"] },
  },
];
function Harness() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <CatalogChoices catalog={catalog} selected={selected} onChange={setSelected} />
      <output aria-label="Selection">{selected.join(",")}</output>
    </>
  );
}
test("families use radio choices and reveal compatible optional extras after a selection", () => {
  renderApp(<Harness />);
  expect(screen.queryByRole("checkbox", { name: "Conditioning" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Haircut · Long" }));
  expect(screen.getByRole("radio", { name: "Haircut · Long" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Conditioning" }));
  expect(screen.getByLabelText("Selection")).toHaveTextContent("long,care");
  expect(screen.getByText("No added time")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove Haircut" }));
  expect(screen.getByLabelText("Selection")).toBeEmptyDOMElement();
  expect(screen.queryByRole("checkbox", { name: "Conditioning" })).toBeNull();
});
test("variants and extras have Spanish labels", () => {
  renderApp(<Harness />, { locale: "es-AR" });
  expect(screen.getByRole("radio", { name: "Haircut · Estándar" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Haircut · Long" }));
  expect(screen.getByRole("group", { name: "Complementos de Haircut · Long" })).toBeInTheDocument();
  expect(screen.getByText("Sin tiempo adicional")).toBeInTheDocument();
});

test("a professional's catalog still offers a qualified variant when its standard parent is absent", () => {
  renderApp(
    <CatalogChoices
      catalog={catalog.filter((s) => s.id !== "cut")}
      selected={[]}
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("checkbox", { name: "Haircut · Long" })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Haircut" })).toBeNull();
});

function SharedExtras() {
  const [selected, setSelected] = useState(["cut", "color"]);
  const choices: Service[] = [
    base,
    { ...base, id: "color", name: "Color" },
    {
      ...base,
      id: "care",
      name: "Conditioning",
      catalog: { kind: "addon", version: 1, allowedServiceIds: ["cut", "color"] },
    },
  ];
  return <CatalogChoices catalog={choices} selected={selected} onChange={setSelected} />;
}
test("a shared extra has unique controls and attaches once to the selected eligible service", () => {
  renderApp(<SharedExtras />);
  const choices = screen.getAllByRole("checkbox", { name: "Conditioning" });
  expect(new Set(choices.map((c) => c.id)).size).toBe(2);
  fireEvent.click(
    within(screen.getByRole("group", { name: "Extras for Color" })).getByRole("checkbox", {
      name: "Conditioning",
    }),
  );
  expect(
    within(screen.getByRole("group", { name: "Extras for Color" })).getByRole("checkbox", {
      name: "Conditioning",
    }),
  ).toBeChecked();
  const haircutExtras = screen.queryByRole("group", { name: "Extras for Haircut" });
  expect(
    haircutExtras ? within(haircutExtras).queryByRole("checkbox", { name: "Conditioning" }) : null,
  ).toBeNull();
});
