import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  type MandateBinding,
  type MandateReference,
  mandateReferenceSchema,
} from "./mandate-types";
export function paymentEncryptionKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("Payment encryption key unavailable");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error("Payment encryption key unavailable");
  return key;
}
function aad(binding: MandateBinding) {
  return Buffer.from(
    JSON.stringify([
      "sob.payment-mandate.v1",
      binding.contractId,
      binding.merchantCode,
      binding.terminal,
      binding.environment,
      binding.currency,
    ]),
  );
}
export function sealMandate(key: string, binding: MandateBinding, reference: MandateReference) {
  const secret = paymentEncryptionKey(key);
  const parsed = mandateReferenceSchema.safeParse(reference);
  if (!parsed.success) throw new Error("Invalid payment reference");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(aad(binding));
  const data = Buffer.concat([cipher.update(JSON.stringify(parsed.data), "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    data.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
export function openMandate(
  key: string,
  binding: MandateBinding,
  payload: string,
): MandateReference {
  try {
    const secret = paymentEncryptionKey(key);
    if (payload.length > 2048) throw new Error();
    const [version, iv, data, tag, ...extra] = payload.split(".");
    if (
      version !== "v1" ||
      !iv ||
      !data ||
      !tag ||
      extra.length ||
      ![iv, data, tag].every((v) => /^[A-Za-z0-9_-]+$/.test(v))
    )
      throw new Error();
    const nonce = Buffer.from(iv, "base64url");
    const authTag = Buffer.from(tag, "base64url");
    if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(aad(binding));
    cipher.setAuthTag(authTag);
    return mandateReferenceSchema.parse(
      JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString(
          "utf8",
        ),
      ),
    );
  } catch {
    throw new Error("Payment reference unavailable");
  }
}
