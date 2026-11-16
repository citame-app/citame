import { expect, test } from "bun:test";
import { combinationCreateSchema, combinationUpdateSchema } from "./service-combinations";

const ids = [crypto.randomUUID(), crypto.randomUUID()];
const input = {
  name: "A sequence",
  description: null,
  serviceIds: ids,
  active: true,
  idempotencyKey: crypto.randomUUID(),
};
test("combinations require unique ordered members and explicit creation/revision fields", () => {
  expect(combinationCreateSchema.parse(input).serviceIds).toEqual(ids);
  for (const change of [
    { serviceIds: [ids[0]] },
    { serviceIds: [ids[0], ids[0]] },
    { name: "\u0000" },
    { description: "\u0000" },
    { unexpectedPrice: 100 },
  ])
    expect(combinationCreateSchema.safeParse({ ...input, ...change }).success).toBe(false);
  const { idempotencyKey: _key, ...fields } = input;
  expect(combinationUpdateSchema.safeParse({ ...fields, version: 1 }).success).toBe(true);
  expect(combinationUpdateSchema.safeParse({ ...fields, version: null }).success).toBe(false);
});
