import type { Context, Env, MiddlewareHandler } from "hono";
import type { ValkeySecondaryStorage } from "./auth/secondary-storage";
import type { RateLimitRule } from "./config";
import { errorBody } from "./http";
import { type Logger, rootLogger } from "./observability/logger";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Whole seconds until the current window ends (at least 1). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Only `increment` is used: it is an atomic INCR + EXPIRE (Lua) in Valkey. */
  storage: Pick<ValkeySecondaryStorage, "increment">;
  /** Epoch milliseconds. Injectable so tests can move through windows deterministically. */
  now?: () => number;
}

/**
 * Fixed-window counter. The window index is derived from the clock, so a window boundary is
 * a new key; the Valkey TTL only exists to garbage-collect old counters. Each request costs
 * one atomic round trip. The known trade-off of fixed windows is a burst of up to 2x `max`
 * straddling a boundary, which is acceptable for brute-force and abuse protection.
 */
export function createRateLimiter({ storage, now = Date.now }: RateLimiterOptions) {
  return {
    async hit(scope: string, identity: string, rule: RateLimitRule): Promise<RateLimitResult> {
      const windowMs = rule.windowSeconds * 1000;
      const nowMs = now();
      const windowIndex = Math.floor(nowMs / windowMs);
      const count = await storage.increment(
        `rl:${scope}:${identity}:${windowIndex}`,
        rule.windowSeconds,
      );
      const windowEndMs = (windowIndex + 1) * windowMs;
      return {
        allowed: count <= rule.max,
        count,
        limit: rule.max,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000)),
      };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

interface BunServerEnv {
  requestIP?: (request: Request) => { address: string } | null;
}

/**
 * Identifies the caller. `X-Forwarded-For` is attacker-controlled unless a proxy you run
 * appends to it, so it is only read with `trustProxy` and then the LAST entry (the address
 * the trusted proxy saw) is used. This assumes exactly one trusted proxy hop.
 */
export function clientIdentity(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const last = forwarded?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  const env = c.env as BunServerEnv | undefined;
  return env?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

export interface RateLimitOptions<E extends Env = Env> {
  limiter: RateLimiter;
  /** Counter namespace, for example `global` or `auth`. */
  scope: string;
  rule: RateLimitRule;
  trustProxy?: boolean;
  /** Verified identity for routes that run this middleware after authentication. */
  identity?: (c: Context<E>) => string;
  /**
   * What to do when the counter store (Valkey) errors. `true` logs and lets the request through
   * (availability over strictness: used by the global limiter); the default `false` rejects the
   * request (used for credential endpoints, where letting brute force through is the worse failure).
   */
  failOpen?: boolean;
  logger?: Logger;
}

export function rateLimit<E extends Env = Env>({
  limiter,
  scope,
  rule,
  trustProxy = false,
  identity = (c) => clientIdentity(c, trustProxy),
  failOpen = false,
  logger = rootLogger,
}: RateLimitOptions<E>): MiddlewareHandler<E> {
  return async (c, next) => {
    const caller = identity(c);
    let result: RateLimitResult;
    try {
      result = await limiter.hit(scope, caller, rule);
    } catch (error) {
      if (!failOpen) throw error;
      logger.error("rate limit store failed, failing open", { scope, err: error });
      await next();
      return;
    }
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return c.json(errorBody("rate_limited", "Too many requests, try again later"), 429);
    }
    await next();
  };
}
