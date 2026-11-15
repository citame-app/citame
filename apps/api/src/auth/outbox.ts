import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type Database, accountEmailOutbox as jobs, salonSettings } from "@sob/db";
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { NotificationConfig } from "../config";
import { renderAuthEmail } from "../notifications/auth-emails";
import type { EmailMessage, EmailProvider } from "../notifications/providers/types";
import { PermanentProviderError } from "../notifications/providers/types";
import { backoffMs } from "../notifications/queue";
import type { NotificationWorker } from "../notifications/worker";
import type { AuthMailRequest } from "./mailer";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (secret: string) =>
  createHash("sha256").update(`sob-account-email-v1\0${secret}`).digest();
type Row = typeof jobs.$inferSelect;

export async function accountEmailQueueStats(db: Database): Promise<Record<string, number>> {
  const stats: Record<string, number> = {
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    overdue: 0,
  };
  const rows = await db.execute<{ status: string; n: number }>(
    sql`select status, count(*)::int as n from account_email_outbox group by status`,
  );
  for (const row of rows) stats[row.status] = row.n;
  const [overdue] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from account_email_outbox where status = 'pending' and scheduled_for < now() - interval '5 minutes'`,
  );
  stats.overdue = overdue?.n ?? 0;
  return stats;
}

function encrypt(secret: string, id: string, message: EmailMessage): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".");
}

function decrypt(secret: string, row: Row): EmailMessage {
  const [version, nonce, tag, body] = row.payload.split(".");
  if (version !== "v1" || !nonce || !tag || !body) throw new Error("payload_unreadable");
  const cipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(nonce, "base64url"));
  cipher.setAAD(Buffer.from(row.id));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(body, "base64url")), cipher.final()]).toString("utf8"),
  );
}

/** Await the database commit, never SMTP. Deduplication and mailbox throttling survive restarts. */
export async function enqueueAccountEmail(
  db: Database,
  secret: string,
  request: AuthMailRequest,
  options: { now?: Date; throttleSeconds?: number } = {},
): Promise<"queued" | "duplicate" | "throttled"> {
  const now = options.now ?? new Date();
  const idempotencyKey = digest(request.idempotencyKey);
  const throttleKey = digest(`${request.kind}:${request.to.trim().toLowerCase()}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${throttleKey}, 0))`);
    if (
      (await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, idempotencyKey)))
        .length
    )
      return "duplicate";
    const since = new Date(now.getTime() - (options.throttleSeconds ?? 60) * 1000);
    if (
      (
        await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.throttleKey, throttleKey), gte(jobs.createdAt, since)))
          .limit(1)
      ).length
    )
      return "throttled";
    const [salon] = await tx.select({ name: salonSettings.name }).from(salonSettings).limit(1);
    const id = Bun.randomUUIDv7();
    const rendered = renderAuthEmail({ ...request, salonName: salon?.name ?? "Sisters of Beauty" });
    const message: EmailMessage = {
      ...rendered,
      to: request.to,
      idempotencyKey: `account-email-${id}`,
      headers: { "X-Auto-Response-Suppress": "All", "Auto-Submitted": "auto-generated" },
    };
    const inserted = await tx
      .insert(jobs)
      .values({
        id,
        idempotencyKey,
        throttleKey,
        payload: encrypt(secret, id, message),
        expiresAt: new Date(now.getTime() + request.expiresInMinutes * 60_000),
        scheduledFor: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning({ id: jobs.id });
    return inserted.length ? "queued" : "duplicate";
  });
}

/** Leased, fenced at-least-once delivery shared by API and standalone worker processes. */
export function createAccountEmailWorker(options: {
  db: Database;
  secret: string;
  provider: EmailProvider | null;
  config: NotificationConfig;
  now?: () => Date;
  workerId?: string;
  random?: () => number;
}): NotificationWorker {
  const { db, config, provider } = options;
  const clock = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `account-mail-${Bun.randomUUIDv7()}`;
  const claimable = (now: Date) =>
    or(eq(jobs.status, "pending"), and(eq(jobs.status, "processing"), lt(jobs.lockedUntil, now)));
  const leaseEnd = () => new Date(clock().getTime() + config.visibilityTimeoutSeconds * 1000);
  const fence = (row: Row) =>
    and(
      eq(jobs.id, row.id),
      eq(jobs.status, "processing"),
      eq(jobs.lockedBy, workerId),
      eq(jobs.attempts, row.attempts),
    );
  async function batch(): Promise<number> {
    if (!provider) return 0;
    const now = clock();
    const claimed = await db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({
          status: "skipped",
          payload: "",
          lastError: "link_expired",
          lockedUntil: null,
          updatedAt: now,
        })
        .where(and(claimable(now), lte(jobs.expiresAt, now)));
      await tx
        .update(jobs)
        .set({
          status: "failed",
          payload: "",
          lastError: "attempts_exhausted",
          lockedUntil: null,
          updatedAt: now,
        })
        .where(and(claimable(now), gte(jobs.attempts, config.maxAttempts)));
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(claimable(now), lte(jobs.scheduledFor, now)))
        .orderBy(jobs.scheduledFor, jobs.id)
        .limit(config.batchSize)
        .for("update", { skipLocked: true });
      if (!due.length) return [];
      return tx
        .update(jobs)
        .set({
          status: "processing",
          attempts: sql`${jobs.attempts} + 1`,
          lockedBy: workerId,
          lockedUntil: leaseEnd(),
          updatedAt: now,
        })
        .where(
          inArray(
            jobs.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
    });
    if (!claimed.length) return 0;
    const waiting = new Set(claimed.map((row) => row.id));
    let renewal: Promise<void> = Promise.resolve();
    const renew = async () => {
      if (!waiting.size) return;
      const owned = await db
        .update(jobs)
        .set({ lockedUntil: leaseEnd() })
        .where(
          and(
            inArray(jobs.id, [...waiting]),
            eq(jobs.status, "processing"),
            eq(jobs.lockedBy, workerId),
          ),
        )
        .returning({ id: jobs.id });
      const ids = new Set(owned.map((row) => row.id));
      for (const id of waiting) if (!ids.has(id)) waiting.delete(id);
    };
    const heartbeat = setInterval(
      () => {
        renewal = renewal.then(renew).catch(() => {
          waiting.clear();
        });
      },
      Math.max(10, (config.visibilityTimeoutSeconds * 1000) / 3),
    );
    try {
      for (const row of claimed) {
        await renewal;
        if (!waiting.has(row.id)) continue;
        if (row.expiresAt.getTime() <= clock().getTime()) {
          await db
            .update(jobs)
            .set({
              status: "skipped",
              payload: "",
              lastError: "link_expired",
              lockedUntil: null,
              updatedAt: clock(),
            })
            .where(fence(row));
          waiting.delete(row.id);
          continue;
        }
        if (
          !(
            await db
              .update(jobs)
              .set({ lockedUntil: leaseEnd() })
              .where(fence(row))
              .returning({ id: jobs.id })
          ).length
        ) {
          waiting.delete(row.id);
          continue;
        }
        let message: EmailMessage;
        try {
          message = decrypt(options.secret, row);
        } catch {
          await db
            .update(jobs)
            .set({
              status: "failed",
              payload: "",
              lastError: "payload_unreadable",
              lockedUntil: null,
              updatedAt: clock(),
            })
            .where(fence(row));
          waiting.delete(row.id);
          continue;
        }
        try {
          await provider.send(message);
          await db
            .update(jobs)
            .set({
              status: "sent",
              payload: "",
              sentAt: clock(),
              lastError: null,
              lockedUntil: null,
              updatedAt: clock(),
            })
            .where(fence(row));
        } catch (error) {
          const terminal =
            error instanceof PermanentProviderError || row.attempts >= config.maxAttempts;
          const retryAt = new Date(
            clock().getTime() +
              backoffMs(
                row.attempts,
                config.backoffBaseSeconds,
                config.backoffMaxSeconds,
                options.random ?? Math.random,
              ),
          );
          // Provider errors can contain addresses or full action URLs. Persist only safe codes.
          await db
            .update(jobs)
            .set({
              status: terminal ? "failed" : "pending",
              payload: terminal ? "" : row.payload,
              lastError: terminal ? "delivery_failed" : "delivery_retry",
              scheduledFor: retryAt,
              lockedUntil: null,
              updatedAt: clock(),
            })
            .where(fence(row));
        }
        waiting.delete(row.id);
      }
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
    return claimed.length;
  }
  let active: Promise<number> | undefined;
  const runOnce = () => {
    active ??= batch().finally(() => {
      active = undefined;
    });
    return active;
  };
  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  return {
    workerId,
    runOnce,
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          let handled = 0;
          try {
            handled = await runOnce();
          } catch {
            /* Durable rows remain available for the next poll. */
          }
          if (running && handled < config.batchSize)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, config.pollIntervalMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
        }
      })();
    },
    async stop() {
      running = false;
      wake?.();
      await loop;
      await active;
    },
  };
}
