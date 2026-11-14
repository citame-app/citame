import { createHmac, timingSafeEqual } from "node:crypto";

export interface OptOutClaims {
  clientId: string;
  channel: "email" | "sms";
}

const VERSION = "v1";
const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(`${VERSION}.${body}`).digest("base64url");

/**
 * Signed, login-free token for the reminder opt-out link. It carries only the client id and
 * the channel, never expires (an unsubscribe link must keep working) and can only ever switch
 * reminders OFF, so a leaked link cannot be abused to read or change anything else.
 */
export function signOptOutToken(secret: string, claims: OptOutClaims): string {
  const body = Buffer.from(JSON.stringify({ c: claims.clientId, ch: claims.channel })).toString(
    "base64url",
  );
  return `${VERSION}.${body}.${sign(secret, body)}`;
}

export function verifyOptOutToken(secret: string, token: string): OptOutClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      c?: unknown;
      ch?: unknown;
    };
    if (typeof parsed.c !== "string" || (parsed.ch !== "email" && parsed.ch !== "sms")) return null;
    return { clientId: parsed.c, channel: parsed.ch };
  } catch {
    return null;
  }
}
