import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

export class InvalidBankNotificationError extends Error {
  constructor() {
    super("Invalid bank notification");
    this.name = "InvalidBankNotificationError";
  }
}

export type RedsysEnvironment = "test" | "live";
export interface RedsysConfig {
  secret: string;
  merchantCode: string;
  terminal: string;
  environment: RedsysEnvironment;
  publicURL: string;
}
export interface HostedPaymentForm {
  action: string;
  fields: { Ds_MerchantParameters: string; Ds_Signature: string; Ds_SignatureVersion: string };
}
export interface BankNotification {
  order: string;
  amountCents: number;
  currency: "EUR";
  transactionType: string;
  responseCode: string;
  success: boolean;
  authorizationCode: string | null;
}
const validOrder = (order: string) => /^\d{4}[A-Za-z0-9]{0,8}$/.test(order);
const validAmount = (amount: number) => Number.isSafeInteger(amount) && amount > 0 && amount < 1e12;

/** Redsys V2 uses the first 16 UTF-8 key characters and the Base64 AES output as HMAC key. */
export function redsysSignature(secret: string, order: string, merchantParameters: string): string {
  if (!secret || !validOrder(order))
    throw new Error("Invalid Redsys signing configuration or order");
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from(secret.slice(0, 16).padEnd(16, "0"), "utf8"),
    Buffer.alloc(16),
  );
  const diversified = Buffer.concat([cipher.update(order, "utf8"), cipher.final()]).toString(
    "base64",
  );
  return createHmac("sha512", diversified).update(merchantParameters, "utf8").digest("base64url");
}

/** Card entry stays on Redsys. Browser return URLs never establish payment status. */
export class RedsysGateway {
  readonly provider = "redsys";
  private readonly config: RedsysConfig;
  constructor(
    config: RedsysConfig,
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {
    if (
      !/^\d{9}$/.test(config.merchantCode) ||
      !/^\d{1,3}$/.test(config.terminal) ||
      !/^[\x20-\x7E]{1,256}$/.test(config.secret)
    )
      throw new Error("Invalid Redsys merchant configuration");
    if (config.environment !== "test" && config.environment !== "live")
      throw new Error("Invalid Redsys environment");
    const origin = new URL(config.publicURL);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("Redsys public URL must be an origin");
    if (
      origin.protocol !== "https:" &&
      !(
        config.environment === "test" &&
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )
    )
      throw new Error("Redsys requires HTTPS outside local tests");
    this.config = {
      ...config,
      publicURL: origin.origin,
      terminal: config.terminal.padStart(3, "0"),
    };
  }
  get environment() {
    return this.config.environment;
  }
  private signed(parameters: Record<string, string>): HostedPaymentForm["fields"] {
    const encoded = Buffer.from(JSON.stringify(parameters), "utf8").toString("base64url");
    return {
      Ds_MerchantParameters: encoded,
      Ds_Signature: redsysSignature(
        this.config.secret,
        parameters.DS_MERCHANT_ORDER ?? "",
        encoded,
      ),
      Ds_SignatureVersion: "HMAC_SHA512_V2",
    };
  }
  checkout(input: {
    order: string;
    amountCents: number;
    currency: string;
    method: "card" | "bizum";
  }): HostedPaymentForm {
    if (!validOrder(input.order) || !validAmount(input.amountCents))
      throw new Error("Invalid payment order or amount");
    if (input.currency !== "EUR")
      throw new Error("Redsys currency must match the EUR merchant account");
    if (input.method !== "card" && input.method !== "bizum")
      throw new Error("Invalid payment method");
    const root = this.config.publicURL;
    return {
      action:
        this.config.environment === "test"
          ? "https://sis-t.redsys.es:25443/sis/realizarPago"
          : "https://sis.redsys.es/sis/realizarPago",
      fields: this.signed({
        DS_MERCHANT_ORDER: input.order,
        DS_MERCHANT_AMOUNT: String(input.amountCents),
        DS_MERCHANT_CURRENCY: "978",
        DS_MERCHANT_TRANSACTIONTYPE: "0",
        DS_MERCHANT_MERCHANTCODE: this.config.merchantCode,
        DS_MERCHANT_TERMINAL: this.config.terminal,
        DS_MERCHANT_MERCHANTURL: `${root}/api/payments/redsys/notify`,
        DS_MERCHANT_URLOK: `${root}/payments/${input.order}`,
        DS_MERCHANT_URLKO: `${root}/payments/${input.order}`,
        ...(input.method === "bizum" ? { DS_MERCHANT_PAYMETHODS: "z" } : {}),
      }),
    };
  }
  async refund(input: {
    order: string;
    amountCents: number;
    currency: string;
    refundId: string;
  }): Promise<BankNotification> {
    if (
      !validOrder(input.order) ||
      !validAmount(input.amountCents) ||
      input.currency !== "EUR" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.refundId)
    )
      throw new Error("Invalid refund request");
    const fields = this.signed({
      DS_MERCHANT_ORDER: input.order,
      DS_MERCHANT_AMOUNT: String(input.amountCents),
      DS_MERCHANT_CURRENCY: "978",
      DS_MERCHANT_TRANSACTIONTYPE: "3",
      DS_MERCHANT_MERCHANTCODE: this.config.merchantCode,
      DS_MERCHANT_TERMINAL: this.config.terminal,
      DS_MERCHANT_MERCHANTDATA: input.refundId,
    });
    try {
      const origin =
        this.config.environment === "test"
          ? "https://sis-t.redsys.es:25443"
          : "https://sis.redsys.es";
      const response = await this.transport(`${origin}/sis/rest/trataPeticionREST`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Bank request failed");
      const result = this.verify((await response.json()) as Record<string, unknown>, "3");
      if (
        result.order !== input.order ||
        result.amountCents !== input.amountCents ||
        result.currency !== input.currency
      )
        throw new Error("Bank refund does not match request");
      return result;
    } catch {
      // A lost response can follow a completed refund. Blind retries could refund twice.
      throw new Error("Bank refund requires reconciliation");
    }
  }
  verify(fields: Record<string, unknown>, expectedType = "0"): BankNotification {
    try {
      return this.verifyMessage(fields, expectedType);
    } catch {
      throw new InvalidBankNotificationError();
    }
  }
  private verifyMessage(fields: Record<string, unknown>, expectedType: string): BankNotification {
    const encoded = fields.Ds_MerchantParameters;
    const signature = fields.Ds_Signature;
    if (
      fields.Ds_SignatureVersion !== "HMAC_SHA512_V2" ||
      typeof encoded !== "string" ||
      encoded.length > 8192 ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) ||
      typeof signature !== "string" ||
      !/^[A-Za-z0-9+/_-]{86}={0,2}$/.test(signature)
    )
      throw new Error("Invalid bank notification");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new Error("Invalid bank notification");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid bank notification");
    const params: Record<string, string> = {};
    const seen = new Set<string>();
    const required = new Set([
      "ds_order",
      "ds_amount",
      "ds_currency",
      "ds_merchantcode",
      "ds_terminal",
      "ds_response",
      "ds_transactiontype",
      "ds_authorisationcode",
    ]);
    for (const [key, value] of Object.entries(parsed)) {
      const name = key.toLowerCase();
      if (seen.has(name)) throw new Error("Invalid bank notification");
      seen.add(name);
      if (required.has(name)) {
        if (typeof value !== "string") throw new Error("Invalid bank notification");
        params[name] = value;
      }
    }
    const order = params.ds_order ?? "";
    const expected = Buffer.from(redsysSignature(this.config.secret, order, encoded), "base64url");
    const actual = Buffer.from(signature, "base64");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error("Invalid bank signature");
    const amountCents = Number(params.ds_amount);
    if (
      params.ds_merchantcode !== this.config.merchantCode ||
      (params.ds_terminal ?? "").padStart(3, "0") !== this.config.terminal ||
      params.ds_currency !== "978" ||
      params.ds_transactiontype !== expectedType ||
      !/^\d{1,12}$/.test(params.ds_amount ?? "") ||
      !validAmount(amountCents) ||
      !/^\d{4}$/.test(params.ds_response ?? "")
    )
      throw new Error("Bank notification does not match merchant or operation");
    const responseCode = params.ds_response ?? "";
    return {
      order,
      amountCents,
      currency: "EUR",
      transactionType: expectedType,
      responseCode,
      success: expectedType === "0" ? Number(responseCode) < 100 : responseCode === "0900",
      authorizationCode: params.ds_authorisationcode?.slice(0, 16) ?? null,
    };
  }
}
