import { expect, test } from "bun:test";
import { promotionSchema, reviewSocialSchema, serviceSchema } from "@sob/contracts";
import { creativeModel, creativeSourceSignature } from "./creative-model";

const service = serviceSchema.parse({
  id: "0198f5a0-7b1c-7000-8000-000000000001",
  name: "Haircut",
  description: "A professional haircut",
  durationMinutes: 45,
  bufferMinutes: 0,
  priceCents: 2000,
  currency: "EUR",
});
const promotion = promotionSchema.parse({
  id: "0198f5a0-7b1c-7000-8000-000000000002",
  code: "SPRING20",
  name: "Spring offer",
  kind: "percent",
  value: 1250,
  minimumSpendCents: 5000,
  maximumDiscountCents: 1000,
  perClientLimit: 2,
  usageLimit: 30,
  startsAt: "2030-03-01T09:00:00Z",
  endsAt: "2030-03-31T18:00:00Z",
  eligibleKinds: ["service"],
  serviceIds: [service.id],
  version: 1,
  createdAt: "2026-03-02T12:00:00Z",
});
const options = { locale: "en" as const, timeZone: "UTC", now: new Date("2026-03-02T12:00:00Z") };
test("a variable-price service creative never advertises a free treatment", () => {
  const model = creativeModel(
    { kind: "service", service: { ...service, priceType: "variable", priceCents: 0 } },
    options,
  );
  expect(model.emphasis).toContain("Price varies");
  expect(model.caption).not.toContain("€0");
});
test("promotion creative keeps every qualifying restriction and advertises a bounded maximum rather than a guaranteed saving", () => {
  const model = creativeModel({ kind: "promotion", promotion, service }, options);
  expect(model.emphasis).toContain("12.5%");
  expect(model.emphasis).toContain("Up to");
  for (const wording of [
    "SPRING20",
    "Haircut",
    "€50",
    "€10",
    "2 uses per client",
    "30 uses total",
    "2030",
    "UTC",
  ])
    expect(model.caption).toContain(wording);
  expect(model.paragraphs.join("\n")).toContain("€50");
  const fixed = creativeModel(
    {
      kind: "promotion",
      promotion: { ...promotion, kind: "fixed", value: 5000, maximumDiscountCents: null },
      service,
    },
    options,
  );
  expect(fixed.emphasis).toContain("€20");
  expect(fixed.emphasis).not.toContain("€50");
});
test("inactive, exhausted, expired and ineligible promotion sources cannot produce advertising", () => {
  for (const change of [
    { active: false },
    { usedCount: 30 },
    { endsAt: "2025-03-01T18:00:00Z" },
    { serviceIds: [promotion.id] },
    { eligibleKinds: ["product"] as const },
  ])
    expect(() =>
      creativeModel(
        {
          kind: "promotion",
          promotion: {
            ...promotion,
            ...change,
            eligibleKinds: [...(change.eligibleKinds ?? promotion.eligibleKinds)],
          },
          service,
        },
        options,
      ),
    ).toThrow();
  expect(() =>
    creativeModel(
      { kind: "promotion", promotion, service: { ...service, currency: "ARS" } },
      options,
    ),
  ).toThrow();
});
test("review artwork uses an explicit excerpt and retains the complete approved wording in its caption", () => {
  const body = "A thoughtful and comfortable visit. ".repeat(30);
  const review = reviewSocialSchema.parse({
    id: promotion.id,
    publicName: "A.",
    rating: 4,
    body,
    services: [],
    reply: null,
    publishedAt: "2026-03-02T12:00:00Z",
    reviewVersion: 2,
    permissionVersion: "public-review-social-v1",
  });
  const model = creativeModel({ kind: "review", review }, options);
  expect(model.reviewExcerpted).toBe(true);
  expect(model.paragraphs[0]?.length).toBeLessThanOrEqual(301);
  expect(body.startsWith(model.paragraphs[0]?.replace(/…$/, "") ?? "missing")).toBe(true);
  expect(model.caption).toContain(body.trim());
  expect(model.caption).toContain("A.");
  expect(model.caption).not.toContain(review.id);
});

test("export fencing tracks price and offer terms but permits another redemption while quota remains", () => {
  const original = { kind: "promotion" as const, promotion, service };
  expect(creativeSourceSignature({ ...original, promotion: { ...promotion, usedCount: 1 } })).toBe(
    creativeSourceSignature(original),
  );
  expect(
    creativeSourceSignature({ ...original, service: { ...service, priceCents: 2500 } }),
  ).not.toBe(creativeSourceSignature(original));
  expect(
    creativeSourceSignature({
      ...original,
      promotion: { ...promotion, minimumSpendCents: 8000, version: 2 },
    }),
  ).not.toBe(creativeSourceSignature(original));
});
test("timed offer artwork includes complete local days, exclusive end and original-booking lead conditions", () => {
  const timed = {
    ...promotion,
    timing: { weekdays: [1, 5], startMinute: 600, endMinute: 780, lastMinuteHours: 24 },
  };
  const model = creativeModel(
    { kind: "promotion", promotion: timed, service },
    { ...options, timeZone: "Europe/Madrid" },
  );
  for (const text of [
    "Monday",
    "Friday",
    "10:00",
    "13:00",
    "before",
    "Europe/Madrid",
    "24 hours",
    "rescheduling",
  ])
    expect(model.caption).toContain(text);
  expect(model.paragraphs.join(" ")).toContain("24 hours");
});
