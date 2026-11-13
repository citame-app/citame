import { z } from "zod";

export const errorCodeSchema = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "slot_taken",
  "version_conflict",
  "invalid_state",
  "rate_limited",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Stable error envelope returned by every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** HTTP status for each error code. Shared so every transport maps errors the same way. */
export const errorStatus = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  slot_taken: 409,
  version_conflict: 409,
  invalid_state: 409,
  rate_limited: 429,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>;
