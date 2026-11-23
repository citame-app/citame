import { expect, test } from "bun:test";
import { booksyCombinationDrafts } from "./combination-drafts";
import { transferFixture } from "./fixtures";
import { sourceUuid } from "./plan";
import { reviewBooksyCombinations, sourceBooksyCombinationTerms } from "./source-combinations";

function fixture() {
  const base = transferFixture().services[0];
  if (!base) throw new Error("Missing fixture service");
  const first = {
    ...base,
    sourceId: "first",
    durationMinutes: 60,
    bufferMinutes: 0,
    priceCents: 5500,
    raw: { variants: [{ id: 1, price: "55.00", duration: 60, staffers: [1, 2] }] },
  };
  const second = {
    ...first,
    sourceId: "second",
    raw: { variants: [{ id: 2, price: "55.00", duration: 60, staffers: [1, 2] }] },
  };
  const variant = {
    id: 3,
    price: "95.00",
    duration: 120,
    staffers: [1],
    combo_children: [
      { service_variant: { id: 2 }, price: "45.00" },
      { service_variant: { id: 1 }, price: "50.00" },
    ],
  };
  const combination = {
    ...first,
    sourceId: "combination",
    active: false,
    durationMinutes: 120,
    priceCents: 9500,
    raw: { combo_type: "S", is_available_for_customer_booking: true, variants: [variant] },
  };
  return { first, second, combination, variant };
}

test("resolves source component order, discount allocation, and staff restriction", () => {
  const { first, second, combination } = fixture();
  expect(sourceBooksyCombinationTerms([first, second, combination])).toEqual([
    {
      sourceId: "combination",
      active: false,
      publiclyAvailable: true,
      terms: {
        type: "S",
        currency: "EUR",
        totalCents: 9500,
        durationMinutes: 120,
        bufferMinutes: 0,
        staffRefs: ["1"],
        commonStaffRefs: ["1", "2"],
        components: [
          {
            serviceRef: "second",
            priceCents: 4500,
            cataloguePriceCents: 5500,
            durationMinutes: 60,
            bufferMinutes: 0,
          },
          {
            serviceRef: "first",
            priceCents: 5000,
            cataloguePriceCents: 5500,
            durationMinutes: 60,
            bufferMinutes: 0,
          },
        ],
      },
      issue: null,
    },
  ]);
});

test("an ambiguous source variant or inconsistent total has no materializable terms", () => {
  const { first, second, combination, variant } = fixture();
  const ambiguous = { ...second, sourceId: "duplicate" };
  expect(sourceBooksyCombinationTerms([first, second, ambiguous, combination])[0]).toMatchObject({
    terms: null,
    issue: "unresolved_component",
  });
  variant.combo_children[1] = { service_variant: { id: 1 }, price: "49.00" };
  expect(sourceBooksyCombinationTerms([first, second, combination])[0]).toMatchObject({
    terms: null,
    issue: "component_price_mismatch",
  });
  expect(reviewBooksyCombinations([first, second, combination])).toMatchObject({
    discountedVersusCatalogue: 1,
    differentQualifiedStaff: 1,
    componentPriceMismatch: 1,
    unverifiedTerms: 0,
  });
});

test("projected component drift and source processing gaps are not verified as materializable", () => {
  const { first, second, combination } = fixture();
  expect(
    sourceBooksyCombinationTerms([{ ...first, durationMinutes: 55 }, second, combination])[0],
  ).toMatchObject({ terms: null, issue: "projection_mismatch" });
  const withGap = {
    ...first,
    raw: { variants: first.raw.variants.map((row) => ({ ...row, gap_hole_duration: 15 })) },
  };
  expect(sourceBooksyCombinationTerms([withGap, second, combination])[0]).toMatchObject({
    terms: null,
    issue: "unsupported_processing",
  });
});

test("native combination drafts bind source services and staff to stable ordered identifiers", () => {
  const { first, second, combination } = fixture();
  const base = transferFixture();
  const staff = base.staff[0];
  if (!staff) throw new Error("Missing professional fixture");
  base.staff = [{ ...staff, sourceId: "1" }];
  base.services = [first, second, combination];
  const model = { base, businessId: base.businessId };
  const [draft] = booksyCombinationDrafts(model);
  if (!draft?.draft) throw new Error("Missing native draft");
  expect(draft).toMatchObject({
    issue: null,
    id: sourceUuid(model.businessId, "serviceCombinations", combination.sourceId),
    originallyPublic: true,
    draft: {
      active: false,
      serviceIds: [
        sourceUuid(model.businessId, "services", second.sourceId),
        sourceUuid(model.businessId, "services", first.sourceId),
      ],
      fixedTerms: {
        pricesCents: [4500, 5000],
        staffIds: [sourceUuid(model.businessId, "staff", "1")],
      },
      idempotencyKey: sourceUuid(model.businessId, "combination-draft-write", combination.sourceId),
    },
  });
  expect(booksyCombinationDrafts(model)).toEqual([draft]);
  base.staff = [{ ...staff, sourceId: "1", active: false }];
  expect(booksyCombinationDrafts(model)[0]).toMatchObject({
    draft: null,
    issue: "inactive_source_reference",
  });
  base.staff = [{ ...staff, sourceId: "1" }];
  base.services = [{ ...first, active: false }, second, combination];
  expect(booksyCombinationDrafts(model)[0]).toMatchObject({
    draft: null,
    issue: "inactive_source_reference",
  });
  base.services = [first, second, combination];
  base.staff = [];
  expect(booksyCombinationDrafts(model)).toEqual([
    { sourceId: combination.sourceId, draft: null, issue: "unmapped_staff" },
  ]);
});
