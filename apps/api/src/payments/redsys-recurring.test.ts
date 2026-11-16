import { expect, test } from "bun:test";
import { RedsysGateway, redsysSignature } from "./redsys";

const secret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const config = {
  secret,
  merchantCode: "999008881",
  terminal: "001",
  environment: "test" as const,
  publicURL: "https://salon.example",
  recurringEnabled: true,
};
const token = {
  reference: "120c14ed9f7264383434fc1154559f1e2bcc2b1c",
  transactionId: "2006031152000",
  expiry: "3412",
  last4: "0003",
};
function signed(extra: Record<string, unknown> = {}) {
  const payload = {
    Ds_Order: "1234abcdefff",
    Ds_Amount: "1000",
    Ds_Currency: "978",
    Ds_MerchantCode: "999008881",
    Ds_Terminal: "1",
    Ds_Response: "0000",
    Ds_TransactionType: "0",
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    Ds_SignatureVersion: "HMAC_SHA512_V2",
    Ds_MerchantParameters: encoded,
    Ds_Signature: redsysSignature(secret, String(payload.Ds_Order), encoded),
  };
}
test("a requested initial card mandate uses Redsys COF fields and cannot silently apply to Bizum or an unconfigured gateway", () => {
  const gateway = new RedsysGateway(config);
  const input = {
    order: "1234abcdefff",
    amountCents: 1000,
    currency: "EUR",
    method: "card" as const,
    createMandate: true,
  };
  const form = gateway.checkout(input);
  expect(
    JSON.parse(Buffer.from(form.fields.Ds_MerchantParameters, "base64url").toString()),
  ).toMatchObject({
    DS_MERCHANT_IDENTIFIER: "REQUIRED",
    DS_MERCHANT_COF_INI: "S",
    DS_MERCHANT_COF_TYPE: "R",
  });
  expect(() => gateway.checkout({ ...input, method: "bizum" })).toThrow();
  expect(() => new RedsysGateway({ ...config, recurringEnabled: false }).checkout(input)).toThrow();
});
test("verified capture metadata returns only bounded opaque reference fields, never PAN or arbitrary bank data", () => {
  const gateway = new RedsysGateway(config);
  const result = gateway.verify(
    signed({
      Ds_Merchant_Identifier: token.reference,
      Ds_Merchant_Cof_Txnid: token.transactionId,
      Ds_ExpiryDate: token.expiry,
      Ds_Card_Last4: token.last4,
      Ds_Card_Number: "454881******0003",
      Ds_EMV3DS: { private: "ignored" },
    }),
  );
  expect(result.mandate).toEqual(token);
  expect(JSON.stringify(result)).not.toContain("454881");
  expect(JSON.stringify(result)).not.toContain("EMV3DS");
  const malformed = gateway.verify(
    signed({
      Ds_Merchant_Identifier: "token too large ".repeat(50),
      Ds_Merchant_Cof_Txnid: token.transactionId,
      Ds_ExpiryDate: "3499",
    }),
  );
  expect(malformed.success).toBe(true);
  expect(malformed.mandate).toBeUndefined();
});
test("a recurring charge is server-to-server, signed, matched and never retried after an unknown outcome", async () => {
  let requests = 0;
  const transport = async (url: string, init: RequestInit) => {
    requests++;
    expect(url).toBe("https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST");
    expect(init.redirect).toBe("error");
    const envelope = JSON.parse(String(init.body));
    const payload = JSON.parse(Buffer.from(envelope.Ds_MerchantParameters, "base64url").toString());
    expect(payload).toMatchObject({
      DS_MERCHANT_IDENTIFIER: token.reference,
      DS_MERCHANT_COF_TXNID: token.transactionId,
      DS_MERCHANT_COF_TYPE: "R",
      DS_MERCHANT_COF_INI: "N",
      DS_MERCHANT_EXCEP_SCA: "MIT",
      DS_MERCHANT_DIRECTPAYMENT: "true",
      DS_MERCHANT_AMOUNT: "1000",
    });
    expect(envelope.Ds_Signature).toBe(
      redsysSignature(secret, "1234abcdefff", envelope.Ds_MerchantParameters),
    );
    return Response.json(signed());
  };
  const gateway = new RedsysGateway(config, transport);
  expect(
    (
      await gateway.chargeRecurring({
        order: "1234abcdefff",
        amountCents: 1000,
        currency: "EUR",
        mandate: token,
      })
    ).success,
  ).toBe(true);
  expect(requests).toBe(1);
  let unknown = 0;
  const broken = new RedsysGateway(config, async () => {
    unknown++;
    throw new Error("Lost response with private token data");
  });
  await expect(
    broken.chargeRecurring({
      order: "1234abcdefff",
      amountCents: 1000,
      currency: "EUR",
      mandate: token,
    }),
  ).rejects.toThrow("Bank recurring payment requires reconciliation");
  expect(unknown).toBe(1);
});
test("mismatched bank amounts cannot complete a recurring payment and expired references fail before transport", async () => {
  let calls = 0;
  const gateway = new RedsysGateway(config, async () => {
    calls++;
    return Response.json(signed({ Ds_Amount: "1001" }));
  });
  await expect(
    gateway.chargeRecurring({
      order: "1234abcdefff",
      amountCents: 1000,
      currency: "EUR",
      mandate: token,
    }),
  ).rejects.toThrow("requires reconciliation");
  expect(calls).toBe(1);
  await expect(
    gateway.chargeRecurring({
      order: "1234abcdefff",
      amountCents: 1000,
      currency: "EUR",
      mandate: { ...token, expiry: "2001" },
    }),
  ).rejects.toThrow("Invalid recurring payment request");
  expect(calls).toBe(1);
});
test("a signed bank decline is definitive while a card is valid through its recorded expiry month", async () => {
  let calls = 0;
  const gateway = new RedsysGateway(
    config,
    async () => {
      calls++;
      return Response.json(signed({ Ds_Response: "0190" }));
    },
    () => new Date("2026-11-30T20:00:00.000Z"),
  );
  const result = await gateway.chargeRecurring({
    order: "1234abcdefff",
    amountCents: 1000,
    currency: "EUR",
    mandate: { ...token, expiry: "2611" },
  });
  expect(result.success).toBe(false);
  expect(result.responseCode).toBe("0190");
  expect(calls).toBe(1);
});
