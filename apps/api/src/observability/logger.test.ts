import { describe, expect, test } from "bun:test";
import { createLogger, redact } from "./logger";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-03-02T12:00:00Z"),
  });
  return { logger, lines, last: () => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  test("writes one JSON object per line with time, level and message", () => {
    const { logger, last } = capture();
    logger.info("hello", { requestId: "r-1", status: 200 });
    expect(last()).toEqual({
      time: "2026-03-02T12:00:00.000Z",
      level: "info",
      msg: "hello",
      requestId: "r-1",
      status: 200,
    });
  });

  test("child loggers add their base fields", () => {
    const { logger, last } = capture();
    logger.child({ component: "worker" }).warn("slow");
    expect(last()).toMatchObject({ component: "worker", level: "warn", msg: "slow" });
  });

  test("secrets are replaced by key name, at any depth", () => {
    const { logger, lines } = capture();
    logger.info("login", {
      password: "hunter2",
      nested: { accessToken: "abc", Authorization: "Bearer xyz", cookie: "a=b", ok: 1 },
      list: [{ secret: "s" }],
    });
    const text = lines.join("");
    for (const leaked of ["hunter2", "abc", "xyz", "a=b", '"s"'])
      expect(text).not.toContain(leaked);
    expect(text).toContain('"ok":1');
    expect(text).toContain("[redacted]");
  });

  test("email addresses, connection strings and bearer tokens inside strings are scrubbed", () => {
    const { logger, lines } = capture();
    logger.error("failed for ana@example.com via postgres://sob:secretpw@db:5432/sob", {
      detail: "Authorization: Bearer eyJhbGciOi.payload.sig and smtp://user:pw@mail:587",
    });
    const text = lines.join("");
    expect(text).not.toContain("ana@example.com");
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("eyJhbGciOi");
    expect(text).not.toContain("user:pw");
    expect(text).toContain("[email]");
  });

  test("errors are serialised with name, scrubbed message and a short stack", () => {
    const { logger, last } = capture();
    logger.error("boom", { err: new TypeError("bad value for ana@example.com") });
    const err = last().err as Record<string, string>;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("bad value for [email]");
    expect(typeof err.stack).toBe("string");
  });

  test("redact never throws on cycles or exotic values", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact({ cyclic, big: 10n, fn: () => 1, date: new Date(0) })).not.toThrow();
  });
});
