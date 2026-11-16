import { expect, test } from "bun:test";
import { webHealthcheckUrl } from "./healthcheck";

test("the container health probe follows the configured listener, including a custom port and IPv6", () => {
  expect(webHealthcheckUrl({})).toBe("http://127.0.0.1:4173/healthz");
  expect(webHealthcheckUrl({ PORT: "4273", HOST: "127.0.0.1" })).toBe(
    "http://127.0.0.1:4273/healthz",
  );
  expect(webHealthcheckUrl({ PORT: "8080", HOST: "0.0.0.0" })).toBe(
    "http://127.0.0.1:8080/healthz",
  );
  expect(webHealthcheckUrl({ PORT: "8080", HOST: "::" })).toBe("http://[::1]:8080/healthz");
  expect(webHealthcheckUrl({ PORT: "8080", HOST: "::1" })).toBe("http://[::1]:8080/healthz");
});
