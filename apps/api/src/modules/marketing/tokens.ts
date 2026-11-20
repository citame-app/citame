import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const claimsSchema = z.object({ clientId: z.uuid(), channel: z.enum(["email", "sms"]) }).strict();
export function signMarketingOptOut(secret: string, claims: z.infer<typeof claimsSchema>) {
  const body = Buffer.from(JSON.stringify(claimsSchema.parse(claims))).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`citame:marketing-optout:v1:${body}`)
    .digest("base64url");
  return `m1.${body}.${signature}`;
}
export function verifyMarketingOptOut(secret: string, token: string) {
  if (token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "m1") return null;
  const body = parts[1]!,
    given = Buffer.from(parts[2]!);
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`citame:marketing-optout:v1:${body}`).digest("base64url"),
  );
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = claimsSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
