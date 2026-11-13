const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Extracts the Postgres SQLSTATE from a driver error, walking the `cause` chain
 * (Drizzle wraps driver errors in a DrizzleQueryError).
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown };
    for (const value of [candidate.errno, candidate.code]) {
      if (typeof value === "string" && SQLSTATE.test(value)) return value;
    }
    current = current.cause;
  }
  return undefined;
}

/** SQLSTATE for `exclusion_violation`, raised by the appointment overlap constraint. */
export const EXCLUSION_VIOLATION = "23P01";
