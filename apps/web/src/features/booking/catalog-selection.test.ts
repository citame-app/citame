import { expect, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { normalizeCatalogSelection, toggleCatalogSelection } from "./catalog-selection";

const base = (id: string): Service => ({
  id,
  name: id,
  description: null,
  durationMinutes: 30,
  bufferMinutes: 0,
  priceCents: 1000,
  currency: "EUR",
});
const catalog: Service[] = [
  base("cut"),
  base("color"),
  {
    ...base("long"),
    catalog: { kind: "variant", version: 1, parentServiceId: "cut", optionLabel: "Long" },
  },
  {
    ...base("short"),
    catalog: { kind: "variant", version: 1, parentServiceId: "cut", optionLabel: "Short" },
  },
  { ...base("care"), catalog: { kind: "addon", version: 1, allowedServiceIds: ["cut"] } },
  { ...base("long-extra"), catalog: { kind: "addon", version: 1, allowedServiceIds: ["long"] } },
];
test("changing a variant keeps compatible family extras and removes incompatible variant-only extras", () => {
  expect(toggleCatalogSelection(["long", "care", "long-extra", "color"], "short", catalog)).toEqual(
    ["short", "care", "color"],
  );
  expect(toggleCatalogSelection(["long", "care", "long-extra", "color"], "long", catalog)).toEqual([
    "color",
  ]);
});
test("an extra is placed after its eligible service even when another service was selected later", () => {
  expect(toggleCatalogSelection(["cut", "color"], "care", catalog, "cut")).toEqual([
    "cut",
    "care",
    "color",
  ]);
  expect(toggleCatalogSelection(["color"], "care", catalog)).toEqual(["color"]);
});
test("URL normalization removes missing, duplicate, conflicting and orphan selections without choosing an unrequested option", () => {
  expect(
    normalizeCatalogSelection(
      ["missing", "care", "cut", "long", "long-extra", "cut", "color"],
      catalog,
    ),
  ).toEqual(["cut", "color"]);
});
test("selection limits prevent an extra from overflowing the request and still allow removals", () => {
  expect(toggleCatalogSelection(["cut", "color"], "care", catalog, "cut", 2)).toEqual([
    "cut",
    "color",
  ]);
  expect(toggleCatalogSelection(["cut", "care"], "cut", catalog, undefined, 2)).toEqual([]);
});
