import { describe, expect, test } from "bun:test";
import { assertSafeProxyConfig } from "./proxy-config";

describe("assertSafeProxyConfig", () => {
  test("trusting X-Forwarded-For while the port is published to the world is refused", () => {
    for (const publish of ["0.0.0.0:4173", "4173", ":4173", "192.168.1.5:4173", "[::]:4173"]) {
      expect(() =>
        assertSafeProxyConfig({ WEB_TRUST_PROXY: "true", WEB_PUBLISH: publish }),
      ).toThrow(/WEB_TRUST_PROXY/);
    }
  });

  test("loopback publishing, an unset binding or no trust are fine", () => {
    assertSafeProxyConfig({ WEB_TRUST_PROXY: "true", WEB_PUBLISH: "127.0.0.1:4173" });
    assertSafeProxyConfig({ WEB_TRUST_PROXY: "true", WEB_PUBLISH: "[::1]:4173" });
    assertSafeProxyConfig({ WEB_TRUST_PROXY: "true" });
    assertSafeProxyConfig({ WEB_TRUST_PROXY: "false", WEB_PUBLISH: "0.0.0.0:4173" });
  });

  test("an explicit acknowledgement allows a trusted edge on a private network", () => {
    assertSafeProxyConfig({
      WEB_TRUST_PROXY: "true",
      WEB_PUBLISH: "0.0.0.0:4173",
      WEB_TRUST_PROXY_UNSAFE_OK: "true",
    });
  });
});
