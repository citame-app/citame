import type { Database } from "@sob/db";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { currentOAuthGrant } from "./connections";

const authorizationCode = z.object({
  type: z.literal("authorization_code"),
  userId: z.string(),
  query: z.object({ client_id: z.string() }),
  resource: z.array(z.string()).optional(),
});

export function invalidMcpGrant() {
  return new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description: "The connection is no longer authorized. Reconnect the application.",
  });
}

export async function bindMcpCodeToGrant(db: Database, value: string, resource: string) {
  // Better Auth stores several kinds of verification values. Only MCP authorization codes
  // carry this payload, and writing it back preserves the provider's PKCE and session fields.
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    return value;
  }
  const code = authorizationCode.safeParse(payload);
  if (!code.success || !code.data.resource?.includes(resource)) return value;
  const grant = await currentOAuthGrant(db, code.data.query.client_id, code.data.userId);
  if (!grant) throw invalidMcpGrant();
  return JSON.stringify({ ...(payload as Record<string, unknown>), referenceId: grant.id });
}
