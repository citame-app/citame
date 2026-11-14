/**
 * Structured JSON logger. One object per line on stdout (the container runtime ships it), with
 * secrets and personal data removed BEFORE anything is written: by key name (passwords, tokens,
 * cookies, addresses ...) and by pattern inside strings (email addresses, URL credentials,
 * bearer tokens). Callers should still log ids rather than values; this is the safety net.
 */

import { currentRequestId } from "./context";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
  base?: Record<string, unknown>;
}

const SENSITIVE_KEY =
  /pass(word|wd)?|token|secret|cookie|authorization|e-?mail|phone|api[-_]?key|signature|hash|session|credential|smtp_?url|database_?url|dsn/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

export function scrubString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(BEARER, "$1 [redacted]")
    .replace(JWT, "[redacted]")
    .replace(EMAIL, "[email]");
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (depth > 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack.split("\n").slice(0, 8).join("\n")) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1, seen);
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const requestId = currentRequestId();
    const entry = {
      time: now().toISOString(),
      level,
      msg: scrubString(msg),
      ...(requestId ? { requestId } : {}),
      ...(redact({ ...base, ...fields }) as Record<string, unknown>),
    };
    write(JSON.stringify(entry));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ write, now, base: { ...base, ...fields } }),
  };
}

/** Shared by everything that does not receive a logger explicitly. */
export const rootLogger = createLogger({
  write: (line) => {
    if (process.env.LOG_LEVEL === "silent") return;
    process.stdout.write(`${line}\n`);
  },
});
