import { type ErrorResponse, errorStatus } from "@sob/contracts";
import type { Context } from "hono";
import type { ZodType, z } from "zod";
import { DomainError } from "./errors";

export function errorBody(code: ErrorResponse["error"]["code"], message: string): ErrorResponse {
  return { error: { code, message } };
}

export function respondError(c: Context, error: DomainError) {
  return c.json(errorBody(error.code, error.message), errorStatus[error.code]);
}

/** Parses data against a contract schema or throws a `validation_error`. */
export function parseOrThrow<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new DomainError("validation_error", message);
  }
  return result.data;
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("validation_error", "Request body must be valid JSON");
  }
}
