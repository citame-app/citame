import { createHmac, timingSafeEqual } from "node:crypto";
import {
  whatsappCompleteSchema,
  whatsappReviewedDisconnectSchema,
  whatsappReviewedRulesSchema,
  whatsappRulesSchema,
} from "@sob/contracts";
import { reminder, whatsappConnection } from "@sob/db";
import { and, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { createMeta, tokenCipher } from "./meta";
import {
  disconnectWhatsApp,
  listDeliveries,
  listTemplates,
  lockWhatsAppConnection,
  readConnection,
  updateWhatsAppRules,
  whatsappDesk,
  whatsappSettings,
} from "./service";

export function whatsappAdminRoutes({
  db,
  config,
  now = () => new Date(),
  whatsappFetch,
}: Pick<AppDeps, "db" | "config" | "now" | "whatsappFetch">) {
  const notifications = config.notifications;
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/", async (c) => c.json(whatsappSettings(notifications, await readConnection(db))))
    .post("/connect", async (c) => {
      const settings = notifications.whatsapp;
      if (!settings) throw new DomainError("invalid_state", "Meta WhatsApp no está configurado.");
      const input = parseOrThrow(whatsappCompleteSchema, await readJson(c));
      if (!notifications.publicUrl.startsWith("https://"))
        throw new DomainError("invalid_state", "La conexión necesita una URL pública HTTPS.");
      const meta = createMeta(settings, whatsappFetch);
      try {
        const connection = await db.transaction(async (tx) => {
          await lockWhatsAppConnection(tx);
          const current = await readConnection(tx);
          const grant = await meta.exchange(input.code);
          const phones = await meta.phones(input.wabaId, grant.access_token);
          const selected = input.phoneId
            ? phones.find((phone) => phone.id === input.phoneId)
            : phones.length === 1
              ? phones[0]
              : undefined;
          if (!selected)
            throw new DomainError(
              "validation_error",
              "Seleccione un único número de la cuenta autorizada en Meta.",
            );
          if (current && (current.wabaId !== input.wabaId || current.phoneId !== selected.id))
            throw new DomainError(
              "invalid_state",
              "Seleccione el número conectado o desconéctelo de Citame antes de cambiarlo.",
            );
          const coexistence = selected.is_on_biz_app === true;
          if (
            !current &&
            !coexistence &&
            !(selected.platform_type === "CLOUD_API" && selected.status === "CONNECTED")
          ) {
            if (!input.pin)
              throw new DomainError(
                "validation_error",
                "El número nuevo necesita un PIN de verificación de seis cifras.",
              );
            await meta.register(selected.id, grant.access_token, input.pin);
          }
          await meta.subscribe(
            input.wabaId,
            grant.access_token,
            `${notifications.publicUrl}/api/whatsapp/webhook`,
          );
          const sender = {
            phone: selected.display_phone_number,
            coexistence,
            encryptedToken: tokenCipher(notifications.signingSecret, selected.id).seal(
              grant.access_token,
            ),
            expiresAt: grant.expires_in
              ? new Date(now().getTime() + grant.expires_in * 1000)
              : null,
          };
          const [saved] = await tx
            .insert(whatsappConnection)
            .values({
              wabaId: input.wabaId,
              phoneId: selected.id,
              ...sender,
            })
            .onConflictDoUpdate({ target: whatsappConnection.id, set: sender })
            .returning();
          if (!saved) throw new Error("Could not persist WhatsApp connection");
          return saved;
        });
        return c.json(whatsappSettings(notifications, connection));
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(
          "invalid_state",
          "Meta no pudo conectar el número. Compruebe los permisos y vuelva a iniciar la conexión.",
        );
      }
    })
    .get("/deliveries", async (c) => c.json(await listDeliveries(db)))
    .get("/desk", async (c) => c.json(await whatsappDesk(db, notifications)))
    .get("/templates", async (c) => {
      const connection = await readConnection(db);
      return c.json(
        connection ? await listTemplates(notifications, connection, whatsappFetch) : [],
      );
    })
    .patch("/rules", bodyLimit({ maxSize: 8192 }), async (c) => {
      const rules = parseOrThrow(whatsappRulesSchema, await readJson(c));
      const saved = await updateWhatsAppRules(db, notifications, rules, now(), whatsappFetch);
      return c.json(whatsappSettings(notifications, saved));
    })
    .patch("/rules/reviewed", bodyLimit({ maxSize: 8192 }), async (c) => {
      const { revision, rules } = parseOrThrow(whatsappReviewedRulesSchema, await readJson(c));
      const saved = await updateWhatsAppRules(
        db,
        notifications,
        rules,
        now(),
        whatsappFetch,
        revision,
      );
      return c.json(whatsappSettings(notifications, saved));
    })
    .delete("/", async (c) => {
      await disconnectWhatsApp(db);
      return c.json(whatsappSettings(notifications, undefined));
    })
    .post("/disconnect/reviewed", bodyLimit({ maxSize: 1024 }), async (c) => {
      const { revision } = parseOrThrow(whatsappReviewedDisconnectSchema, await readJson(c));
      await disconnectWhatsApp(db, revision);
      return c.json(whatsappSettings(notifications, undefined));
    });
}

const envelope = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});
const deliveries = z.object({
  metadata: z.object({ phone_number_id: z.string() }),
  statuses: z.array(z.unknown()).optional(),
});
const delivery = z.object({
  id: z.string().min(1).max(250),
  biz_opaque_callback_data: z.uuid(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
});

export function signedMetaPayload(secret: string, payload: ArrayBuffer, signature?: string) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(Buffer.from(payload)).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function whatsappWebhookRoutes({ db, config }: Pick<AppDeps, "db" | "config">) {
  const meta = config.notifications.whatsapp;
  return new Hono()
    .get("/", (c) => {
      const token = c.req.query("hub.verify_token");
      const challenge = c.req.query("hub.challenge");
      if (
        !meta ||
        token !== meta.verifyToken ||
        c.req.query("hub.mode") !== "subscribe" ||
        !challenge ||
        !/^\d{1,64}$/.test(challenge)
      )
        return c.text("Forbidden", 403);
      return c.text(challenge);
    })
    .post("/", bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
      const payload = await c.req.arrayBuffer();
      if (!meta || !signedMetaPayload(meta.appSecret, payload, c.req.header("x-hub-signature-256")))
        return c.text("Forbidden", 403);
      const parsed = envelope.safeParse(await new Response(payload).json().catch(() => null));
      if (!parsed.success) return c.text("Invalid payload", 400);
      for (const entry of parsed.data.entry) {
        for (const change of entry.changes) {
          if (change.field !== "messages") continue;
          const data = deliveries.safeParse(change.value);
          if (!data.success) continue;
          const phoneId = data.data.metadata.phone_number_id;
          const legacySender = exists(
            db
              .select({ id: whatsappConnection.id })
              .from(whatsappConnection)
              .where(
                and(
                  eq(whatsappConnection.id, 1),
                  eq(whatsappConnection.wabaId, entry.id),
                  eq(whatsappConnection.phoneId, phoneId),
                ),
              ),
          );
          for (const item of data.data.statuses ?? []) {
            const parsedStatus = delivery.safeParse(item);
            if (!parsedStatus.success) continue;
            const status = parsedStatus.data;
            const earlier =
              status.status === "read"
                ? ["sent", "delivered", "failed"]
                : status.status === "delivered"
                  ? ["sent", "failed"]
                  : status.status === "failed"
                    ? ["sent"]
                    : [];
            await db
              .update(reminder)
              .set({ whatsappDelivery: status.status, providerMessageId: status.id })
              .where(
                and(
                  eq(reminder.id, status.biz_opaque_callback_data),
                  eq(reminder.channel, "whatsapp"),
                  isNotNull(reminder.whatsappDispatchAt),
                  or(
                    and(
                      eq(reminder.whatsappDispatchWabaId, entry.id),
                      eq(reminder.whatsappDispatchPhoneId, phoneId),
                    ),
                    // Older sends lack a stored sender. Only mirror a known message ID
                    // from the still-connected sender; never infer the origin of an unknown send.
                    and(
                      isNull(reminder.whatsappDispatchWabaId),
                      isNull(reminder.whatsappDispatchPhoneId),
                      eq(reminder.providerMessageId, status.id),
                      legacySender,
                    ),
                  ),
                  sql`(${reminder.providerMessageId} is null or ${reminder.providerMessageId} = ${status.id})`,
                  earlier.length
                    ? sql`(${reminder.whatsappDelivery} is null or ${inArray(reminder.whatsappDelivery, earlier)})`
                    : sql`${reminder.whatsappDelivery} is null`,
                ),
              );
          }
        }
      }
      return c.body(null, 204);
    });
}
