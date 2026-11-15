import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { RedsysGateway, redsysSignature } from "./redsys";

// Public example from the Redsys signing specification, never a deployment credential.
const secret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const reference =
  "eyJEU19NRVJDSEFOVF9BTU9VTlQiOiI5OTkiLCJEU19NRVJDSEFOVF9PUkRFUiI6IjEyMzQ1Njc4OTAiLCJEU19NRVJDSEFOVF9NRVJDSEFOVENPREUiOiI5OTkwMDg4ODEiLCJEU19NRVJDSEFOVF9DVVJSRU5DWSI6Ijk3OCIsIkRTX01FUkNIQU5UX1RSQU5TQUNUSU9OVFlQRSI6IjAiLCJEU19NRVJDSEFOVF9URVJNSU5BTCI6IjEiLCJEU19NRVJDSEFOVF9NRVJDSEFOVFVSTCI6Imh0dHA6XC9cL3d3dy5wcnVlYmEuY29tXC91cmxOb3RpZmljYWNpb24ucGhwIiwiRFNfTUVSQ0hBTlRfVVJMT0siOiJodHRwOlwvXC93d3cucHJ1ZWJhLmNvbVwvdXJsT0sucGhwIiwiRFNfTUVSQ0hBTlRfVVJMS08iOiJodHRwOlwvXC93d3cucHJ1ZWJhLmNvbVwvdXJsS08ucGhwIn0";
const config = {
  secret,
  merchantCode: "999008881",
  terminal: "001",
  environment: "test" as const,
  publicURL: "https://salon.example",
};
const gateway = new RedsysGateway(config);
const notification = (extra: Record<string, string | undefined> = {}) => {
  const params = {
    Ds_Order: "1234567890",
    Ds_Amount: "999",
    Ds_Currency: "978",
    Ds_MerchantCode: "999008881",
    Ds_Terminal: "1",
    Ds_Response: "0000",
    Ds_TransactionType: "0",
    Ds_AuthorisationCode: "123456",
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify(params)).toString("base64url");
  return {
    Ds_MerchantParameters: encoded,
    Ds_Signature: redsysSignature(secret, params.Ds_Order ?? "", encoded),
    Ds_SignatureVersion: "HMAC_SHA512_V2",
  };
};

describe("Redsys hosted checkout", () => {
  test("matches the official AES-CBC / HMAC-SHA512_V2 reference vector", () => {
    expect(redsysSignature(secret, "1234567890", reference)).toBe(
      "Vjo02eSWq249IeZZp3R-ArFnGLhKY0OuzDDlx1BuVtZDC2yhczA7_11uZhsYzLZBCMFAz8u8uzGDX3AErHKmmw",
    );
  });
  test("short merchant keys are zero-padded as characters, not base64 decoded", () => {
    expect(redsysSignature("short", "1234567890", reference)).toBe(
      redsysSignature("short00000000000", "1234567890", reference),
    );
  });
  test("builds a hosted form with server-chosen return and notification URLs", () => {
    const form = gateway.checkout({
      order: "1234567890",
      amountCents: 999,
      currency: "EUR",
      method: "card",
    });
    expect(form.action).toBe("https://sis-t.redsys.es:25443/sis/realizarPago");
    expect(form.fields.Ds_SignatureVersion).toBe("HMAC_SHA512_V2");
    const params = JSON.parse(
      Buffer.from(form.fields.Ds_MerchantParameters, "base64url").toString(),
    );
    expect(params).toMatchObject({
      DS_MERCHANT_ORDER: "1234567890",
      DS_MERCHANT_AMOUNT: "999",
      DS_MERCHANT_CURRENCY: "978",
      DS_MERCHANT_TRANSACTIONTYPE: "0",
      DS_MERCHANT_TERMINAL: "001",
      DS_MERCHANT_MERCHANTURL: "https://salon.example/api/payments/redsys/notify",
      DS_MERCHANT_URLOK: "https://salon.example/payments/1234567890",
      DS_MERCHANT_URLKO: "https://salon.example/payments/1234567890",
    });
    expect(JSON.stringify(form)).not.toContain(secret);
    expect(form.fields.Ds_Signature).toBe(
      redsysSignature(secret, "1234567890", form.fields.Ds_MerchantParameters),
    );
  });
  test("Bizum uses the same signed form and live mode uses only the official endpoint", () => {
    const form = new RedsysGateway({ ...config, environment: "live" }).checkout({
      order: "12345678ABCD",
      amountCents: 1250,
      currency: "EUR",
      method: "bizum",
    });
    expect(form.action).toBe("https://sis.redsys.es/sis/realizarPago");
    expect(
      JSON.parse(Buffer.from(form.fields.Ds_MerchantParameters, "base64url").toString())
        .DS_MERCHANT_PAYMETHODS,
    ).toBe("z");
  });
  test("rejects invalid amounts, currencies, orders and merchant configuration", () => {
    for (const amountCents of [0, -1, 1.2, Number.NaN, 1e12])
      expect(() =>
        gateway.checkout({ order: "1234567890", amountCents, currency: "EUR", method: "card" }),
      ).toThrow();
    for (const order of ["abc12345", "1234<script>", "1234567890123", "123"])
      expect(() =>
        gateway.checkout({ order, amountCents: 999, currency: "EUR", method: "card" }),
      ).toThrow();
    expect(() =>
      gateway.checkout({ order: "1234567890", amountCents: 999, currency: "ARS", method: "card" }),
    ).toThrow("currency");
    expect(
      () =>
        new RedsysGateway({ ...config, publicURL: "http://salon.example", environment: "live" }),
    ).toThrow();
    expect(() => new RedsysGateway({ ...config, merchantCode: "missing" })).toThrow();
    expect(() => new RedsysGateway({ ...config, secret: "" })).toThrow();
  });
});

describe("signed notifications", () => {
  test("verifies a successful callback and treats bank declines as unpaid", () => {
    expect(gateway.verify(notification())).toMatchObject({
      order: "1234567890",
      amountCents: 999,
      currency: "EUR",
      transactionType: "0",
      responseCode: "0000",
      success: true,
    });
    expect(gateway.verify(notification({ Ds_Response: "0099" })).success).toBe(true);
    expect(gateway.verify(notification({ Ds_Response: "0190" })).success).toBe(false);
  });
  test("rejects tampering and unsigned, oversized or malformed messages", () => {
    const good = notification();
    expect(() =>
      gateway.verify({
        ...good,
        Ds_Signature: createHmac("sha512", "attacker")
          .update(good.Ds_MerchantParameters)
          .digest("base64url"),
      }),
    ).toThrow();
    expect(() => gateway.verify({ ...good, Ds_SignatureVersion: "HMAC_SHA256_V1" })).toThrow();
    expect(() => gateway.verify({ ...good, Ds_MerchantParameters: "A".repeat(20_000) })).toThrow();
    expect(() =>
      gateway.verify({ ...good, Ds_MerchantParameters: Buffer.from("[]").toString("base64url") }),
    ).toThrow();
    expect(() => gateway.verify({ ...good, Ds_Signature: "!!!!" })).toThrow();
  });
  test("checks merchant, terminal, operation type and required numeric values after signature verification", () => {
    for (const change of [
      { Ds_MerchantCode: "999008882" },
      { Ds_Terminal: "2" },
      { Ds_Amount: "9.99" },
      { Ds_Currency: "032" },
      { Ds_Response: "" },
      { Ds_TransactionType: "3" },
    ] satisfies Record<string, string>[])
      expect(() => gateway.verify(notification(change))).toThrow();
  });
});

test("refunds use the original order and validate the signed bank result", async () => {
  let posted: Record<string, string> = {};
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST");
    expect(init?.redirect).toBe("error");
    const envelope = JSON.parse(String(init?.body));
    posted = JSON.parse(Buffer.from(envelope.Ds_MerchantParameters, "base64url").toString());
    const result = notification({ Ds_TransactionType: "3", Ds_Response: "0900", Ds_Amount: "300" });
    return Response.json(result);
  };
  const response = await new RedsysGateway(config, transport).refund({
    order: "1234567890",
    amountCents: 300,
    currency: "EUR",
    refundId: "local-refund-id",
  });
  expect(response.success).toBe(true);
  expect(posted).toMatchObject({
    DS_MERCHANT_ORDER: "1234567890",
    DS_MERCHANT_AMOUNT: "300",
    DS_MERCHANT_TRANSACTIONTYPE: "3",
    DS_MERCHANT_MERCHANTDATA: "local-refund-id",
  });
});
test("an ambiguous refund result is not silently retried or reported as successful", async () => {
  for (const reply of [
    () => {
      throw new Error("timeout with private bank data");
    },
    () => Response.json({ errorCode: "SIS9999" }),
    () =>
      Response.json(
        notification({ Ds_TransactionType: "3", Ds_Response: "0900", Ds_Amount: "301" }),
      ),
  ]) {
    let calls = 0;
    const transport = async () => {
      calls++;
      return reply();
    };
    await expect(
      new RedsysGateway(config, transport).refund({
        order: "1234567890",
        amountCents: 300,
        currency: "EUR",
        refundId: "refund-test",
      }),
    ).rejects.toThrow("requires reconciliation");
    expect(calls).toBe(1);
  }
});

test("valid signatures tolerate extra bank metadata without trusting or persisting its shape", () => {
  const good = notification();
  const params = {
    ...JSON.parse(Buffer.from(good.Ds_MerchantParameters, "base64url").toString()),
    Ds_ExtraMetadata: { gatewayVersion: "next" },
  };
  const encoded = Buffer.from(JSON.stringify(params)).toString("base64url");
  expect(
    gateway.verify({
      ...good,
      Ds_MerchantParameters: encoded,
      Ds_Signature: redsysSignature(secret, params.Ds_Order, encoded),
    }).success,
  ).toBe(true);
});
