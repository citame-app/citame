import { expect, test } from "bun:test";
import { clientPhotoUploadSchema } from "./client-photos";

test("private photo uploads require a caption, explicit storage permission and a reusable identifier", () => {
  const input = {
    caption: "Before colour",
    imageBase64: "aGVsbG8=",
    permissionConfirmed: true,
    idempotencyKey: "0198f5a0-7b1c-7000-8000-0000000000a1",
  };
  expect(clientPhotoUploadSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { permissionConfirmed: false },
    { caption: "" },
    { caption: "x".repeat(301) },
    { imageBase64: "not base64" },
    { capturedOn: "yesterday" },
    { public: true },
  ])
    expect(clientPhotoUploadSchema.safeParse({ ...input, ...change }).success).toBe(false);
});

test("the encoded photo envelope enforces the exact decoded byte boundary", () => {
  const input = {
    caption: "Boundary fixture",
    permissionConfirmed: true,
    idempotencyKey: "0198f5a0-7b1c-7000-8000-0000000000a1",
  };
  expect(
    clientPhotoUploadSchema.safeParse({
      ...input,
      imageBase64: Buffer.alloc(524288).toString("base64"),
    }).success,
  ).toBe(true);
  expect(
    clientPhotoUploadSchema.safeParse({
      ...input,
      imageBase64: Buffer.alloc(524289).toString("base64"),
    }).success,
  ).toBe(false);
});
