import { expect, test } from "bun:test";
import { createAppointmentBaseSchema } from "./appointments";

const id = "0198f5a0-7b1c-7000-8000-000000000101";
const request = { staffId: id, serviceIds: [id], startsAt: "2026-03-09T12:00:00.000Z" };
test("a booking carries the exact reviewed service quotes when a client supplies them", () => {
  const serviceQuotes = { [id]: "a".repeat(64) };
  expect(createAppointmentBaseSchema.parse({ ...request, serviceQuotes })).toMatchObject({
    serviceQuotes,
  });
  expect(
    createAppointmentBaseSchema.safeParse({ ...request, serviceQuotes: { [id]: "invalid" } })
      .success,
  ).toBe(false);
  expect(createAppointmentBaseSchema.safeParse({ ...request, serviceQuotes: {} }).success).toBe(
    false,
  );
});

test("MCP callers can carry the same reviewed quote fence", async () => {
  const { mcpCreateAppointmentInput } = await import("./mcp");
  const serviceQuotes = { [id]: "a".repeat(64) };
  expect(mcpCreateAppointmentInput.parse({ ...request, serviceQuotes })).toMatchObject({
    serviceQuotes,
  });
});
