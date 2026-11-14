import { type Database, salonSettings } from "@sob/db";
import type { RedisClient } from "bun";
import { type AuthEmailKind, renderAuthEmail } from "../notifications/auth-emails";
import type { EmailProvider } from "../notifications/providers/types";
import { PermanentProviderError } from "../notifications/providers/types";
import type { Locale } from "../notifications/templates";
import type { Logger } from "../observability/logger";

export interface AuthMailRequest {
  kind: AuthEmailKind;
  to: string;
  url: string;
  locale: Locale;
  expiresInMinutes: number;
  /** Stable per link, so a provider that deduplicates cannot send the same link twice. */
  idempotencyKey: string;
}

export interface AuthMailer {
  /** Fire and forget by design: callers never wait for (or learn the outcome of) a send. */
  send(request: AuthMailRequest): void;
  /** Resolves once every send started so far has settled. For tests and graceful shutdown. */
  flush(): Promise<void>;
}

export interface AuthMailerDeps {
  provider: EmailProvider | null;
  db: Database;
  valkey: RedisClient;
  keyPrefix: string;
  logger: Logger;
  /** One email of a given kind per address and window (seconds). Mail bombing protection. */
  throttleSeconds?: number;
  retryDelaysMs?: readonly number[];
}

/**
 * Sends account emails (verification, reset, invitation) through the same EmailProvider the
 * reminder worker uses. Sends are detached from the request: if the caller waited, the response
 * time would tell an attacker which addresses have accounts. Failures are retried briefly in
 * process; if the provider stays down the person can simply ask again (the endpoints are
 * rate limited, not one-shot). Account emails deliberately do not go through the reminder
 * table: they have no appointment, and a durable queue for a link that expires in an hour buys
 * little (ADR 0011).
 */
export function createAuthMailer(deps: AuthMailerDeps): AuthMailer {
  const throttle = deps.throttleSeconds ?? 60;
  const delays = deps.retryDelaysMs ?? [500, 2000];
  const inFlight = new Set<Promise<void>>();

  async function salonName(): Promise<string> {
    try {
      const [row] = await deps.db.select({ name: salonSettings.name }).from(salonSettings).limit(1);
      return row?.name ?? "Sisters of Beauty";
    } catch {
      return "Sisters of Beauty";
    }
  }

  async function run(request: AuthMailRequest) {
    const log = deps.logger.child({ component: "auth-mail", kind: request.kind });
    if (!deps.provider) {
      log.warn("account email not sent: no email provider is configured");
      return;
    }
    // Address as key material, hashed: the raw address never reaches Valkey or the logs.
    const digest = new Bun.CryptoHasher("sha256").update(request.to.toLowerCase()).digest("hex");
    const key = `${deps.keyPrefix}mail-throttle:${request.kind}:${digest.slice(0, 32)}`;
    const claimed = await deps.valkey.send("SET", [key, "1", "NX", "EX", String(throttle)]);
    if (claimed !== "OK") {
      log.info("account email throttled");
      return;
    }
    const rendered = renderAuthEmail({
      kind: request.kind,
      locale: request.locale,
      salonName: await salonName(),
      url: request.url,
      expiresInMinutes: request.expiresInMinutes,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.provider.send({
          to: request.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          idempotencyKey: request.idempotencyKey,
          headers: { "X-Auto-Response-Suppress": "All", "Auto-Submitted": "auto-generated" },
        });
        log.info("account email sent");
        return;
      } catch (error) {
        const delay = delays[attempt];
        if (error instanceof PermanentProviderError || delay === undefined) {
          log.error("account email failed", { err: error, attempts: attempt + 1 });
          return;
        }
        await Bun.sleep(delay);
      }
    }
  }

  return {
    send(request) {
      const task = run(request)
        .catch((error) => deps.logger.error("account email crashed", { err: error }))
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    async flush() {
      await Promise.all([...inFlight]);
    },
  };
}
