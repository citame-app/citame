import { expect, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { acceptedServiceQuotes } from "./quotes";

const service: Service = {
  id: "cut",
  name: "Haircut",
  description: null,
  durationMinutes: 45,
  bufferMinutes: 15,
  priceCents: 2000,
  currency: "EUR",
  quoteHash: "a".repeat(64),
};
test("reviewed service identities travel with their exact catalog quotes", () => {
  expect(
    acceptedServiceQuotes([service, { ...service, id: "extra", quoteHash: "b".repeat(64) }]),
  ).toEqual({ cut: "a".repeat(64), extra: "b".repeat(64) });
});
test("old catalogs and empty selections omit the optional compatibility fence", () => {
  expect(acceptedServiceQuotes([])).toBeUndefined();
  expect(acceptedServiceQuotes([service, { ...service, quoteHash: undefined }])).toBeUndefined();
});
