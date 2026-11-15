import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  salonSettings,
  staffProfile,
} from "@sob/db";
import { asc, eq } from "drizzle-orm";
import type { NotificationConfig } from "../config";
import { type Metrics, processMetrics } from "./metrics";
import { categoryOf, isEnabled } from "./preferences";
import type { Providers } from "./providers";
import { PermanentProviderError } from "./providers/types";
import { backoffMs, claimDue, finishClaim, type ReminderRow, renewLeases } from "./queue";
import { LOCALES, type Locale, type MessageData, renderEmail, renderSms } from "./templates";
import { signOptOutToken } from "./tokens";

export interface WorkerOptions {
  db: Database;
  config: NotificationConfig;
  providers: Providers;
  now?: () => Date;
  workerId?: string;
  random?: () => number;
  /** Structured log sink; defaults to JSON lines on stdout. Receives ids, never addresses. */
  log?: (entry: Record<string, unknown>) => void;
  metrics?: Metrics;
}

export interface NotificationWorker {
  /** Claims and processes one batch; resolves to the number of jobs handled. */
  runOnce(): Promise<number>;
  /** Starts the polling loop. */
  start(): void;
  /** Stops polling and waits for the job in flight (graceful shutdown). */
  stop(): Promise<void>;
  readonly workerId: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;

type Prepared =
  | { skip: string }
  | { channel: "email"; to: string; data: MessageData }
  | { channel: "sms"; to: string; data: MessageData };

/** Reads the current state and decides whether (and what) to send. Never throws on bad data. */
async function prepare(
  db: Database,
  row: ReminderRow,
  config: NotificationConfig,
  providers: Providers,
  now: Date,
): Promise<Prepared> {
  const provider = row.channel === "email" ? providers.email : providers.sms;
  if (!provider) return { skip: "channel_disabled" };

  const [appt] = await db.select().from(appointment).where(eq(appointment.id, row.appointmentId));
  if (!appt || appt.deletedAt) return { skip: "appointment_gone" };
  if (row.kind === "cancellation") {
    if (appt.status !== "cancelled") return { skip: "not_cancelled" };
  } else {
    if (appt.status !== "booked") return { skip: "appointment_not_booked" };
    if (appt.startsAt.getTime() <= now.getTime()) return { skip: "already_started" };
  }

  const [client] = await db.select().from(clientProfile).where(eq(clientProfile.id, appt.clientId));
  if (!client || client.deletedAt) return { skip: "client_gone" };
  const rawAddress = row.channel === "email" ? client.email : client.phone;
  if (!rawAddress) return { skip: "no_address" };
  let to = rawAddress.trim();
  if (row.channel === "sms") {
    to = to.replace(/[\s().-]/g, "");
    if (!E164.test(to)) return { skip: "invalid_phone" };
  }
  const category = categoryOf(row.kind);
  if (!(await isEnabled(db, client.id, row.channel, category))) return { skip: "opted_out" };

  const [settings] = await db.select().from(salonSettings).limit(1);
  const [staff] = await db
    .select({ name: staffProfile.displayName })
    .from(staffProfile)
    .where(eq(staffProfile.id, appt.staffId));
  const services = await db
    .select({ name: appointmentService.name })
    .from(appointmentService)
    .where(eq(appointmentService.appointmentId, appt.id))
    .orderBy(asc(appointmentService.position));
  if (!settings) return { skip: "salon_not_configured" };

  const locale: Locale = LOCALES.includes(client.locale as Locale)
    ? (client.locale as Locale)
    : config.defaultLocale;
  const optOutToken =
    category === "reminder" && row.channel === "email"
      ? signOptOutToken(config.signingSecret, { clientId: client.id, channel: "email" })
      : undefined;
  const data: MessageData = {
    kind: row.kind,
    locale,
    salonName: settings.name,
    timeZone: settings.timezone,
    startsAt: appt.startsAt,
    endsAt: appt.endsAt,
    version: appt.version,
    services: services.map((s) => s.name),
    staffName: staff?.name ?? "",
    appointmentId: appt.id,
    manageUrl: `${config.publicUrl}/account`,
    rescheduleUrl: `${config.publicUrl}/account/appointments/${appt.id}/reschedule`,
    optOutUrl: optOutToken
      ? `${config.publicUrl}/notifications/opt-out?token=${optOutToken}`
      : undefined,
  };
  return row.channel === "email" ? { channel: "email", to, data } : { channel: "sms", to, data };
}

export function createNotificationWorker(options: WorkerOptions): NotificationWorker {
  const { db, config, providers } = options;
  const clock = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `${process.pid}-${Bun.randomUUIDv7().slice(-8)}`;
  const random = options.random ?? Math.random;
  const metrics = options.metrics ?? processMetrics;
  const log =
    options.log ??
    ((entry: Record<string, unknown>) =>
      console.log(
        JSON.stringify({ time: new Date().toISOString(), component: "notifications", ...entry }),
      ));

  async function handle(row: ReminderRow): Promise<void> {
    const base = {
      workerId,
      reminderId: row.id,
      kind: row.kind,
      channel: row.channel,
      attempt: row.attempts,
    };
    const finish = async (outcome: Parameters<typeof finishClaim>[3]) => {
      const owned = await finishClaim(db, row, workerId, outcome);
      if (!owned) {
        metrics.inc("lease_lost");
        log({ level: "warn", msg: "lease lost before recording the outcome", ...base });
      }
      return owned;
    };

    try {
      const prepared = await prepare(db, row, config, providers, clock());
      if ("skip" in prepared) {
        metrics.inc("skipped");
        log({ level: "info", msg: "skipped", reason: prepared.skip, ...base });
        await finish({ status: "skipped", reason: prepared.skip });
        return;
      }
      let result: { messageId: string };
      if (prepared.channel === "email") {
        const rendered = renderEmail(prepared.data);
        const optOut = prepared.data.optOutUrl
          ? new URL(prepared.data.optOutUrl).searchParams.get("token")
          : null;
        result = await (providers.email as NonNullable<Providers["email"]>).send({
          to: prepared.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          ics: rendered.ics,
          headers: optOut
            ? {
                "List-Unsubscribe": `<${config.publicUrl}/api/notifications/opt-out?token=${optOut}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : undefined,
          idempotencyKey: row.id,
        });
      } else {
        result = await (providers.sms as NonNullable<Providers["sms"]>).send({
          to: prepared.to,
          body: renderSms(prepared.data),
          idempotencyKey: row.id,
        });
      }
      if (await finish({ status: "sent", providerMessageId: result.messageId, at: clock() })) {
        metrics.inc("sent");
        log({ level: "info", msg: "sent", providerMessageId: result.messageId, ...base });
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      metrics.inc("errors");
      const permanent = error instanceof PermanentProviderError;
      if (permanent || row.attempts >= config.maxAttempts) {
        metrics.inc("dead_lettered");
        log({ level: "error", msg: "dead-lettered", permanent, error: message, ...base });
        await finish({ status: "failed", error: message });
        return;
      }
      const delay = backoffMs(
        row.attempts,
        config.backoffBaseSeconds,
        config.backoffMaxSeconds,
        random,
      );
      metrics.inc("retried");
      log({ level: "warn", msg: "retry scheduled", retryInMs: delay, error: message, ...base });
      await finish({
        status: "pending",
        error: message,
        retryAt: new Date(clock().getTime() + delay),
      });
    }
  }

  async function runOnce(): Promise<number> {
    const claimed = await claimDue(db, {
      now: clock(),
      limit: config.batchSize,
      visibilitySeconds: config.visibilityTimeoutSeconds,
      workerId,
      maxAttempts: config.maxAttempts,
    });
    metrics.inc("claimed", claimed.length);
    let waiting = [...claimed];
    while (waiting.length > 0) {
      const row = waiting.shift() as ReminderRow;
      await handle(row);
      // Keep the leases of the jobs still waiting alive, and drop any that were taken over.
      const owned = new Set(
        await renewLeases(
          db,
          waiting.map((r) => r.id),
          workerId,
          clock(),
          config.visibilityTimeoutSeconds,
        ),
      );
      waiting = waiting.filter((r) => owned.has(r.id));
    }
    return claimed.length;
  }

  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  async function poll() {
    while (running) {
      let handled = 0;
      try {
        handled = await runOnce();
      } catch (error) {
        metrics.inc("errors");
        log({ level: "error", msg: "poll failed", error: String(error), workerId });
      }
      // A full batch means more is probably waiting: go straight back for it.
      if (running && handled < config.batchSize) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    }
  }

  return {
    workerId,
    runOnce,
    start() {
      if (running) return;
      running = true;
      log({ level: "info", msg: "worker started", workerId });
      loop = poll();
    },
    async stop() {
      if (!running) return;
      running = false;
      wake?.();
      await loop;
      log({ level: "info", msg: "worker stopped", workerId });
    },
  };
}
