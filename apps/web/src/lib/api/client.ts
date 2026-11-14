import { type ErrorCode, errorCodeSchema } from "@sob/contracts";
import type { ZodType, z } from "zod";

/** Codes the web app derives from Better Auth's own error bodies (`/api/auth/*`). */
export type AuthErrorCode =
  | "invalid_credentials"
  | "email_taken"
  | "weak_password"
  | "invalid_email"
  | "unknown";

export type ApiErrorCode = ErrorCode | AuthErrorCode;

/** The API answered with a non-2xx status. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** The request never produced a response: offline, DNS, connection refused. */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(cause?: unknown) {
    super("Network request failed", { cause });
  }
}

/** The API answered 2xx but the body does not match the shared contract. */
export class ResponseShapeError extends Error {
  override readonly name = "ResponseShapeError";
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`Unexpected response from ${path}: ${issues}`);
  }
}

export type RequestFailure = ApiError | NetworkError | ResponseShapeError;

const BETTER_AUTH_CODES: Record<string, AuthErrorCode> = {
  INVALID_EMAIL_OR_PASSWORD: "invalid_credentials",
  USER_ALREADY_EXISTS: "email_taken",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "email_taken",
  PASSWORD_TOO_SHORT: "weak_password",
  PASSWORD_TOO_LONG: "weak_password",
  INVALID_EMAIL: "invalid_email",
};

export interface ApiClientOptions {
  /** Where REST paths (`/services`, `/appointments`) are sent. `/api` in the browser (BFF). */
  restBase: string;
  /** Where `/api/auth/*` paths are sent. Empty in the browser, the internal API URL on the server. */
  authBase: string;
  fetch?: typeof fetch;
  /** Extra headers on every request, e.g. the visitor's cookie while rendering on the server. */
  headers?: () => Record<string, string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function toApiError(status: number, body: unknown, retryAfter: string | null): ApiError {
  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
  const retry = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined;

  const envelope = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const parsedCode = errorCodeSchema.safeParse(envelope?.code);
  if (parsedCode.success) {
    return new ApiError(
      parsedCode.data,
      status,
      typeof envelope?.message === "string" ? envelope.message : parsedCode.data,
      retry,
    );
  }

  const betterAuth = body as { code?: unknown; message?: unknown } | null;
  if (typeof betterAuth?.code === "string") {
    const mapped = BETTER_AUTH_CODES[betterAuth.code] ?? "unknown";
    const message = typeof betterAuth.message === "string" ? betterAuth.message : betterAuth.code;
    // Better Auth never answers our 429 envelope, but keep the semantic if a proxy added one.
    return new ApiError(status === 429 ? "rate_limited" : mapped, status, message, retry);
  }
  return new ApiError(status === 429 ? "rate_limited" : "unknown", status, `HTTP ${status}`, retry);
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function urlFor(path: string, query?: RequestOptions["query"]): string {
    const base = path.startsWith("/api/auth") ? options.authBase : options.restBase;
    const joined = `${base}${path}`;
    if (!query) return joined;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${joined}?${qs}` : joined;
  }

  async function request<S extends ZodType>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: S,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const headers = new Headers(options.headers?.());
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await doFetch(urlFor(path, requestOptions.query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "include",
        signal: requestOptions.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new NetworkError(error);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw toApiError(response.status, parsed, response.headers.get("retry-after"));
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ResponseShapeError(
        path,
        result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    return result.data;
  }

  return {
    get: <S extends ZodType>(path: string, schema: S, requestOptions?: RequestOptions) =>
      request("GET", path, schema, undefined, requestOptions),
    post: <S extends ZodType>(path: string, body: unknown, schema: S, o?: RequestOptions) =>
      request("POST", path, schema, body, o),
    patch: <S extends ZodType>(path: string, body: unknown, schema: S, o?: RequestOptions) =>
      request("PATCH", path, schema, body, o),
    put: <S extends ZodType>(path: string, body: unknown, schema: S, o?: RequestOptions) =>
      request("PUT", path, schema, body, o),
    delete: <S extends ZodType>(path: string, schema: S, o?: RequestOptions) =>
      request("DELETE", path, schema, undefined, o),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
