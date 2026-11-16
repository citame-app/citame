import { expect, test } from "bun:test";
import { portfolioPublishSchema, portfolioUploadSchema } from "./portfolio";

test("portfolio uploads are separate raster drafts and publication needs fresh explicit rights confirmation", () => {
  const draft = {
    idempotencyKey: crypto.randomUUID(),
    caption: " Finished style ",
    alt: "A finished style viewed from behind",
    imageBase64: "YWJj",
  };
  expect(portfolioUploadSchema.parse(draft)).toMatchObject({
    caption: "Finished style",
    serviceId: null,
  });
  expect(
    portfolioUploadSchema.safeParse({ ...draft, clientPhotoId: crypto.randomUUID() }).success,
  ).toBe(false);
  expect(portfolioUploadSchema.safeParse({ ...draft, alt: " " }).success).toBe(false);
  expect(
    portfolioPublishSchema.safeParse({ version: 1, publicationConfirmed: false }).success,
  ).toBe(false);
  expect(portfolioPublishSchema.safeParse({ version: 1, publicationConfirmed: true }).success).toBe(
    true,
  );
});
