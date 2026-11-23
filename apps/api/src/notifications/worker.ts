import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  reminder,
  salonSettings,
  staffProfile,
} from "@sob/db";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import type { NotificationConfig } from "../config";
import { resolveNotificationEmail } from "./email-delivery";
import { type Metrics, processMetrics } from "./metrics";
import { categoryOf, isEnabled, whatsappNumber } from "./preferences";
import type { Providers } from "./providers";
import { PermanentProviderError, TransientProviderError } from "./providers/types";
import {
  backoffMs,
  claimDue,
  finishClaim,
  type ReminderRow,
  releaseUnstartedReminders,
  renewLeases,
  WHATSAPP_DELIVERY_UNKNOWN,
} from "./queue";
import { LOCALES, type Locale, type MessageData, renderEmail, renderSms } from "./templates";
import { signOptOutToken } from "./tokens";
import { createMeta, MetaRequestError } from "./whatsapp/meta";
import {
  activeRules,
  buildTemplateMessage,
  readConnection,
  requestToken,
} from "./whatsapp/service";

export interface WorkerOptions {
  db: Database;
  config: NotificationConfig;
  providers: Providers;
  now?: () => Date;
  workerId?: string;
  random?: () => number;
  /** Structured log sink; defaults to JSON lines on stdout. Receives ids, never addresses. */
  whatsappFetch?: typeof fetch;
  emailFetch?: typeof fetch;
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

type Prepared =
  | { skip: string }
  | {
      channel: "email" | "sms" | "whatsapp";
      to: string;
      data: MessageData;
      clientName: string;
      clientId: string;
    };

/** Reads the current state and decides whether (and what) to send. Never throws on bad data. */
async function prepare(
  db: Database,
  row: ReminderRow,
  config: NotificationConfig,
  providers: Providers,
  now: Date,
): Promise<Prepared> {
  const provider =
    row.channel === "email"
      ? providers.email
      : row.channel === "sms"
        ? providers.sms
        : config.whatsapp;
  if (!provider) return { skip: "channel_disabled" };

  const [appt] = await db.select().from(appointment).where(eq(appointment.id, row.appointmentId));
  if (!appt || appt.deletedAt) return { skip: "appointment_gone" };
  if (row.kind === "cancellation") {
    if (appt.status !== "cancelled") return { skip: "not_cancelled" };
  } else {
    if (appt.status !== "booked") return { skip: "appointment_not_booked" };
    if (appt.startsAt.getTime() <= now.getTime()) return { skip: "already_started" };
  }

  const [client] = await db
    .select()
    .from(clientProfile)
    .where(eq(clientProfile.id, sql`client_root_id(${appt.clientId}::uuid)`));
  if (!client || client.deletedAt) return { skip: "client_gone" };
  const rawAddress = row.channel === "email" ? client.email : client.phone;
  if (!rawAddress) return { skip: "no_address" };
  const to = row.channel === "email" ? rawAddress.trim() : whatsappNumber(rawAddress);
  if (!to) return { skip: row.channel === "email" ? "no_address" : "invalid_phone" };
  const category = categoryOf(row.kind);
  if (!(await isEnabled(db, client.id, row.channel, category, to))) return { skip: "opted_out" };

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
    category === "reminder" && row.channel !== "sms"
      ? signOptOutToken(config.signingSecret, { clientId: client.id, channel: row.channel })
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
  return { channel: row.channel, to, data, clientName: client.name, clientId: client.id };
}

/** Recheck the exact recipient and their consent immediately before dispatch. */
async function contactChanged(
  db: Pick<Database, "select">,
  row: ReminderRow,
  prepared: Exclude<Prepared, { skip: string }>,
) {
  const [contact] = await db
    .select({ email: clientProfile.email, phone: clientProfile.phone })
    .from(clientProfile)
    .where(
      and(
        eq(clientProfile.id, prepared.clientId),
        isNull(clientProfile.deletedAt),
        isNull(clientProfile.mergedIntoId),
      ),
    );
  const address = row.channel === "email" ? contact?.email?.trim() : whatsappNumber(contact?.phone);
  if (address !== prepared.to) {
    return row.channel === "email" ? "contact_email_changed" : "contact_phone_changed";
  }
  if (!(await isEnabled(db, prepared.clientId, row.channel, categoryOf(row.kind), prepared.to))) {
    return "opted_out";
  }
  return null;
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

    const claim = () =>
      and(
        eq(reminder.id, row.id),
        eq(reminder.status, "processing"),
        eq(reminder.lockedBy, workerId),
        eq(reminder.attempts, row.attempts),
        gte(reminder.lockedUntil, clock()),
      );
    const staleContact = async (reason: string) => {
      await finish(
        reason === "opted_out" || row.attempts >= config.maxAttempts
          ? { status: "skipped", reason }
          : { status: "pending", error: reason, retryAt: clock() },
      );
    };
    let clearWhatsAppDispatch = false;
    try {
      if (row.whatsappDispatchAt) {
        await finish({ status: "failed", error: WHATSAPP_DELIVERY_UNKNOWN });
        return;
      }
      const email =
        row.channel === "email"
          ? await resolveNotificationEmail(db, config, providers.email, options.emailFetch)
          : null;
      const prepared = await prepare(db, row, config, { ...providers, email }, clock());
      if ("skip" in prepared) {
        metrics.inc("skipped");
        log({ level: "info", msg: "skipped", reason: prepared.skip, ...base });
        await finish({ status: "skipped", reason: prepared.skip });
        return;
      }
      if (prepared.channel !== "whatsapp") {
        const reason = await contactChanged(db, row, prepared);
        if (reason) {
          await staleContact(reason);
          return;
        }
        // A reschedule or cancellation may have withdrawn this job during preparation.
        const [owned] = await db.select({ id: reminder.id }).from(reminder).where(claim());
        if (!owned) return;
      }
      let result: { messageId: string };
      if (prepared.channel === "email") {
        const rendered = renderEmail(prepared.data);
        const optOut = prepared.data.optOutUrl
          ? new URL(prepared.data.optOutUrl).searchParams.get("token")
          : null;
        if (!email) throw new Error("Email provider missing after delivery preparation");
        result = await email.send({
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
      } else if (prepared.channel === "sms") {
        result = await (providers.sms as NonNullable<Providers["sms"]>).send({
          to: prepared.to,
          body: renderSms(prepared.data),
          idempotencyKey: row.id,
        });
      } else {
        const meta = config.whatsapp;
        if (!meta) {
          await finish({ status: "skipped", reason: "whatsapp_rule_inactive" });
          return;
        }
        const dispatch = await db.transaction(async (tx) => {
          // Rules and connection changes lock this row before retiring queued deliveries.
          // Keep the chosen sender and template consistent with the dispatch marker.
          const connection = await readConnection(tx, "share");
          const rule = activeRules(connection, clock()).find((item) => item.kind === row.kind);
          if (!connection || !rule) return { status: "inactive" } as const;
          const [owned] = await tx
            .select({ id: reminder.id })
            .from(reminder)
            .where(and(claim(), isNull(reminder.whatsappDispatchAt)))
            .for("update");
          if (!owned) return { status: "unavailable" } as const;
          const locale = rule.template.language.replaceAll("_", "-");
          const format = (options: Intl.DateTimeFormatOptions) =>
            new Intl.DateTimeFormat(locale, {
              ...options,
              timeZone: prepared.data.timeZone,
            }).format(prepared.data.startsAt);
          const body = buildTemplateMessage(rule, prepared.to, row.id, {
            client: prepared.clientName,
            salon: prepared.data.salonName,
            date: format({ dateStyle: "long" }),
            time: format({ hour: "2-digit", minute: "2-digit", hour12: false }),
            staff: prepared.data.staffName,
            services: prepared.data.services.join(", "),
            preferences: prepared.data.optOutUrl ?? `${config.publicUrl}/account/notifications`,
          });
          const token = requestToken(config, connection);
          const reason = await contactChanged(tx, row, prepared);
          if (reason) return { status: "contact_changed", reason } as const;
          // Meta's Send API does not deduplicate by a client-supplied key.
          await tx
            .update(reminder)
            .set({
              whatsappDispatchAt: clock(),
              whatsappDispatchWabaId: connection.wabaId,
              whatsappDispatchPhoneId: connection.phoneId,
            })
            .where(eq(reminder.id, owned.id));
          return { status: "ready", phoneId: connection.phoneId, token, body } as const;
        });
        if (dispatch.status === "inactive") {
          await finish({ status: "skipped", reason: "whatsapp_rule_inactive" });
          return;
        }
        if (dispatch.status === "contact_changed") {
          await staleContact(dispatch.reason);
          return;
        }
        if (dispatch.status === "unavailable") return;
        try {
          result = {
            messageId: await createMeta(meta, options.whatsappFetch).send(
              dispatch.phoneId,
              dispatch.token,
              dispatch.body,
            ),
          };
        } catch (error) {
          const status = error instanceof MetaRequestError ? error.status : 0;
          if (status === 429) {
            clearWhatsAppDispatch = true;
            throw new TransientProviderError("whatsapp_rate_limited");
          }
          throw new PermanentProviderError(
            status >= 400 && status < 500
              ? `whatsapp_rejected_${status}`
              : WHATSAPP_DELIVERY_UNKNOWN,
          );
        }
      }
      if (await finish({ status: "sent", providerMessageId: result.messageId, at: clock() })) {
        metrics.inc("sent");
        log({ level: "info", msg: "sent", providerMessageId: result.messageId, ...base });
      }
    } catch (error) {
      const permanent = error instanceof PermanentProviderError;
      const message =
        permanent || error instanceof TransientProviderError
          ? error.message
          : "notification_attempt_failed";
      metrics.inc("errors");
      if (permanent || row.attempts >= config.maxAttempts) {
        metrics.inc("dead_lettered");
        log({ level: "error", msg: "dead-lettered", permanent, error: message, ...base });
        await finish({ status: "failed", error: message, clearWhatsAppDispatch });
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
        clearWhatsAppDispatch,
        retryAt: new Date(clock().getTime() + delay),
      });
    }
  }

  let draining = false;

  async function runOnce(): Promise<number> {
    if (draining) return 0;
    const claimed = await claimDue(db, {
      now: clock(),
      limit: config.batchSize,
      visibilitySeconds: config.visibilityTimeoutSeconds,
      workerId,
      maxAttempts: config.maxAttempts,
    });
    metrics.inc("claimed", claimed.length);
    if (!claimed.length) return 0;
    let waiting = [...claimed];
    const claimedIds = claimed.map((row) => row.id);
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        renewal ??= renewLeases(db, claimedIds, workerId, clock(), config.visibilityTimeoutSeconds)
          .then(() => {})
          .catch(() => {
            metrics.inc("errors");
            log({ level: "warn", msg: "lease renewal failed", workerId });
          })
          .finally(() => {
            renewal = undefined;
          });
      },
      Math.max(10, Math.floor((config.visibilityTimeoutSeconds * 1000) / 3)),
    );
    try {
      while (waiting.length > 0) {
        if (draining) {
          await releaseUnstartedReminders(
            db,
            waiting.map((row) => row.id),
            workerId,
          );
          break;
        }
        const row = waiting.shift() as ReminderRow;
        await handle(row);
        if (draining) continue;
        // Refresh waiting jobs before advancing, even if the timer was delayed.
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
    } finally {
      clearInterval(heartbeat);
      await renewal;
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
      } catch {
        metrics.inc("errors");
        log({ level: "error", msg: "poll failed", workerId });
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
      draining = false;
      running = true;
      log({ level: "info", msg: "worker started", workerId });
      loop = poll();
    },
    async stop() {
      draining = true;
      running = false;
      wake?.();
      await loop;
      log({ level: "info", msg: "worker stopped", workerId });
    },
  };
}
