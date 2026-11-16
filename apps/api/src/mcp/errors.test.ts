import { expect, test } from "bun:test";
import { errorResult } from "./errors";

test("a quote conflict directs agents to reload services and ask for review before retrying", () => {
  const result = errorResult({ code: "version_conflict", message: "Service terms changed" });
  expect(result.content[0]?.text).toContain("list_services");
  expect(result.content[0]?.text).toContain("customer");
});
