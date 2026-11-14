import { describe, expect, test } from "bun:test";
import { signOptOutToken, verifyOptOutToken } from "./tokens";

const secret = "sob.notifications.v1:secret-secret-secret-secret-0123456789";
const claims = { clientId: "0190aaaa-0000-7000-8000-000000000001", channel: "email" as const };

describe("opt-out tokens", () => {
  test("round-trips the claims", () => {
    expect(verifyOptOutToken(secret, signOptOutToken(secret, claims))).toEqual(claims);
  });

  test("rejects a tampered payload or signature", () => {
    const token = signOptOutToken(secret, claims);
    const [v, payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ c: "0190aaaa-0000-7000-8000-000000000002", ch: "email" }),
    ).toString("base64url");
    expect(verifyOptOutToken(secret, `${v}.${forged}.${sig}`)).toBeNull();
    expect(verifyOptOutToken(secret, `${v}.${payload}.${sig?.slice(0, -2)}AA`)).toBeNull();
  });

  test("rejects another secret, garbage and an unknown version", () => {
    const token = signOptOutToken(secret, claims);
    expect(verifyOptOutToken("other-secret-other-secret-other-secret", token)).toBeNull();
    expect(verifyOptOutToken(secret, "not-a-token")).toBeNull();
    expect(verifyOptOutToken(secret, token.replace(/^v1/, "v9"))).toBeNull();
    expect(verifyOptOutToken(secret, "")).toBeNull();
  });
});
