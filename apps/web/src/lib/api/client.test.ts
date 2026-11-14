import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ApiError, createApiClient, NetworkError, ResponseShapeError } from "./client";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

interface Call {
  url: string;
  init: RequestInit;
}

function clientWith(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const client = createApiClient({
    restBase: "/api",
    authBase: "",
    fetch: (async (url: string, init: RequestInit = {}) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const thing = z.object({ id: z.number() });

describe("api client requests", () => {
  test("prefixes REST paths with the same-origin base and validates the response", async () => {
    const { client, calls } = clientWith(() => json({ id: 7 }));
    expect(await client.get("/services", thing)).toEqual({ id: 7 });
    expect(calls[0]?.url).toBe("/api/services");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  test("auth paths are not prefixed twice", async () => {
    const { client, calls } = clientWith(() => json({ id: 1 }));
    await client.post("/api/auth/sign-in/email", { email: "a@b.co" }, thing);
    expect(calls[0]?.url).toBe("/api/auth/sign-in/email");
  });

  test("serializes query parameters and drops undefined ones", async () => {
    const { client, calls } = clientWith(() => json({ id: 1 }));
    await client.get("/availability", thing, {
      query: { serviceIds: "a,b", staffId: undefined, date: "2026-03-09" },
    });
    expect(calls[0]?.url).toBe("/api/availability?serviceIds=a%2Cb&date=2026-03-09");
  });

  test("sends JSON bodies with a content type", async () => {
    const { client, calls } = clientWith(() => json({ id: 2 }));
    await client.patch("/appointments/x", { version: 1 }, thing);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe('{"version":1}');
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  test("an absolute server base is used as is for REST and auth", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      restBase: "http://api:3000",
      authBase: "http://api:3000",
      fetch: (async (url: string) => {
        calls.push(url);
        return json({ id: 1 });
      }) as unknown as typeof fetch,
    });
    await client.get("/me", thing);
    await client.post("/api/auth/sign-out", {}, thing);
    expect(calls).toEqual(["http://api:3000/me", "http://api:3000/api/auth/sign-out"]);
  });

  test("forwards extra headers such as the session cookie during SSR", async () => {
    const calls: Call[] = [];
    const client = createApiClient({
      restBase: "http://api:3000",
      authBase: "http://api:3000",
      headers: () => ({ cookie: "session=abc" }),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json({ id: 1 });
      }) as unknown as typeof fetch,
    });
    await client.get("/me", thing);
    expect(new Headers(calls[0]?.init.headers).get("cookie")).toBe("session=abc");
  });
});

describe("api client errors", () => {
  test("maps the stable error envelope to a typed ApiError", async () => {
    const { client } = clientWith(() =>
      json({ error: { code: "slot_taken", message: "Slot already booked" } }, { status: 409 }),
    );
    const error = await client.post("/appointments", {}, thing).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("slot_taken");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Slot already booked");
  });

  test("reads Retry-After on a 429", async () => {
    const { client } = clientWith(() =>
      json(
        { error: { code: "rate_limited", message: "Too many requests" } },
        { status: 429, headers: { "retry-after": "42", "content-type": "application/json" } },
      ),
    );
    const error = await client.get("/services", thing).catch((e) => e);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(42);
  });

  test("maps Better Auth error bodies to stable auth codes", async () => {
    const { client } = clientWith(() =>
      json(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        { status: 401 },
      ),
    );
    const error = await client.post("/api/auth/sign-in/email", {}, thing).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("invalid_credentials");
    expect(error.status).toBe(401);
  });

  test("maps the verification and token errors Better Auth raises", async () => {
    for (const [code, expected] of [
      ["EMAIL_NOT_VERIFIED", "email_not_verified"],
      ["INVALID_TOKEN", "invalid_token"],
    ] as const) {
      const { client } = clientWith(() => json({ code, message: code }, { status: 403 }));
      const error = await client.post("/api/auth/sign-in/email", {}, thing).catch((e) => e);
      expect(error.code).toBe(expected);
    }
  });

  test("maps duplicate email and weak password from Better Auth", async () => {
    for (const [code, expected] of [
      ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "email_taken"],
      ["USER_ALREADY_EXISTS", "email_taken"],
      ["PASSWORD_TOO_SHORT", "weak_password"],
      ["PASSWORD_TOO_LONG", "weak_password"],
    ] as const) {
      const { client } = clientWith(() => json({ code, message: "x" }, { status: 422 }));
      const error = await client.post("/api/auth/sign-up/email", {}, thing).catch((e) => e);
      expect(error.code).toBe(expected);
    }
  });

  test("an unknown error body still yields an ApiError with the status", async () => {
    const { client } = clientWith(() => new Response("Bad Gateway", { status: 502 }));
    const error = await client.get("/services", thing).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("unknown");
    expect(error.status).toBe(502);
  });

  test("a 200 that breaks the contract is a ResponseShapeError", async () => {
    const { client } = clientWith(() => json({ id: "not a number" }));
    const error = await client.get("/services", thing).catch((e) => e);
    expect(error).toBeInstanceOf(ResponseShapeError);
  });

  test("a failing fetch is a NetworkError, distinct from API errors", async () => {
    const client = createApiClient({
      restBase: "/api",
      authBase: "",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const error = await client.get("/services", thing).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});
