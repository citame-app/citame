import { createHash, createHmac } from "node:crypto";
export function giftCode(secret: string, id: string, nonce: string): string {
  const key = createHmac("sha256", secret).update("sob.gift-card-code.v1").digest();
  const value = createHmac("sha256", key)
    .update(`${id}:${nonce}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `SOB-${value.match(/.{4}/g)?.join("-")}`;
}
export const giftCodeHash = (code: string) =>
  createHash("sha256").update(code.trim().toUpperCase().replace(/[ -]/g, "")).digest("hex");
