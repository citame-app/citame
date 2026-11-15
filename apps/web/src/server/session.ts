import type { MeResponse } from "@sob/contracts";
import { ApiError } from "../lib/api/client";

/**
 * Who is signed in, from the API's `me` call. A 401 simply means "signed out". A 429 is NOT that:
 * the visitor may well be signed in, so it propagates and the visit is answered with a
 * rate-limit page instead of silently rendering (or redirecting) them as a guest. Any other
 * failure must not break public pages: it is logged and treated as signed out.
 */
export async function resolveSession(
  lookup: () => Promise<MeResponse>,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): Promise<MeResponse | null> {
  try {
    return await lookup();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return null;
      if (error.status === 429) throw error;
    }
    log("session lookup failed", error);
    return null;
  }
}
