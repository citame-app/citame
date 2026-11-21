import { createHash } from "node:crypto";
import {
  type WhatsAppRule,
  type WhatsAppTemplate,
  whatsappDeliveriesSchema,
  whatsappDeskSchema,
  whatsappKindSchema,
  whatsappRuleSchema,
  whatsappTemplateSchema,
} from "@sob/contracts";
import { type Database, reminder, whatsappConnection } from "@sob/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { backfillWhatsAppReminders } from "../outbox";
import { createMeta, tokenCipher } from "./meta";

const savedRule = whatsappRuleSchema.extend({ template: whatsappTemplateSchema });
const savedRules = z.array(savedRule);
type SavedRule = z.infer<typeof savedRule>;

export async function readConnection(db: Pick<Database, "select">, lock?: "share" | "update") {
  const query = db.select().from(whatsappConnection).where(eq(whatsappConnection.id, 1));
  const [connection] = await (lock ? query.for(lock) : query);
  return connection;
}

type ConnectedSender = NonNullable<Awaited<ReturnType<typeof readConnection>>>;

function senderRevision(connection: ConnectedSender) {
  return createHash("sha256")
    .update(JSON.stringify([connection.encryptedToken, connection.rules]))
    .digest("hex");
}

export function activeRules(connection: Awaited<ReturnType<typeof readConnection>>, now: Date) {
  if (!connection || (connection.expiresAt && connection.expiresAt <= now)) return [];
  return savedRules.parse(connection.rules);
}

export function requestToken(
  config: NotificationConfig,
  connection: NonNullable<Awaited<ReturnType<typeof readConnection>>>,
) {
  return tokenCipher(config.signingSecret, connection.phoneId).open(connection.encryptedToken);
}

export function whatsappSettings(
  config: NotificationConfig,
  connection: Awaited<ReturnType<typeof readConnection>>,
) {
  const meta = config.whatsapp;
  return {
    setup: meta ? { appId: meta.appId, configId: meta.configId, version: meta.version } : null,
    connection: connection
      ? {
          phone: connection.phone,
          revision: senderRevision(connection),
          coexistence: connection.coexistence,
          rules: savedRules
            .parse(connection.rules)
            .map(({ kind, templateId, variables }) => ({ kind, templateId, variables })),
          expiresAt: connection.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function listDeliveries(db: Pick<Database, "select">) {
  const rows = await db
    .select({
      id: reminder.id,
      kind: reminder.kind,
      scheduledFor: reminder.scheduledFor,
      status: reminder.status,
      delivery: reminder.whatsappDelivery,
      lastError: reminder.lastError,
    })
    .from(reminder)
    .where(eq(reminder.channel, "whatsapp"))
    .orderBy(desc(reminder.updatedAt), desc(reminder.id))
    .limit(20);
  return whatsappDeliveriesSchema.parse(
    rows.map((row) => ({ ...row, scheduledFor: row.scheduledFor.toISOString() })),
  );
}

export async function whatsappDesk(db: Database, config: NotificationConfig) {
  const [connection, deliveries] = await Promise.all([readConnection(db), listDeliveries(db)]);
  return whatsappDeskSchema.parse({
    configured: Boolean(config.whatsapp),
    connection: connection
      ? {
          phone: connection.phone,
          revision: senderRevision(connection),
          coexistence: connection.coexistence,
          expiresAt: connection.expiresAt?.toISOString() ?? null,
          rules: savedRules
            .parse(connection.rules)
            .map(({ kind, templateId, variables, template }) => ({
              kind,
              templateId,
              variables,
              templateName: template.name,
              language: template.language,
            })),
        }
      : null,
    deliveries: deliveries.map(({ lastError, ...delivery }) => ({
      ...delivery,
      uncertain: !delivery.delivery && lastError === "whatsapp_delivery_unknown",
    })),
  });
}

export async function updateWhatsAppRules(
  db: Database,
  config: NotificationConfig,
  rules: WhatsAppRule[],
  now: Date,
  request?: typeof fetch,
  reviewedRevision?: string,
) {
  const connection = await readConnection(db);
  if (!connection)
    throw new DomainError("invalid_state", "Conecte un número para guardar automatizaciones.");
  const loadedRevision = senderRevision(connection);
  const changed = () =>
    new DomainError(
      "version_conflict",
      "Las automatizaciones cambiaron. Cargue los ajustes actuales.",
    );
  if (reviewedRevision && reviewedRevision !== loadedRevision) throw changed();
  const mapped = rules.length
    ? mapRules(rules, await listTemplates(config, connection, request))
    : [];
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await readConnection(tx, "update");
    if (!current || senderRevision(current) !== loadedRevision) throw changed();
    const [updated] = await tx
      .update(whatsappConnection)
      .set({ rules: mapped })
      .where(eq(whatsappConnection.id, 1))
      .returning();
    if (!updated) throw changed();
    const enabled = new Set(rules.map(({ kind }) => kind));
    const disabled = whatsappKindSchema.options.filter((kind) => !enabled.has(kind));
    if (disabled.length)
      await tx
        .update(reminder)
        .set({ status: "cancelled", lockedUntil: null, lastError: "whatsapp_rule_disabled" })
        .where(
          and(
            eq(reminder.channel, "whatsapp"),
            inArray(reminder.kind, disabled),
            inArray(reminder.status, ["pending", "processing"]),
            isNull(reminder.whatsappDispatchAt),
          ),
        );
    await backfillWhatsAppReminders(tx, now, enabled);
    return updated;
  });
}

export async function lockWhatsAppConnection(tx: Tx) {
  const [lock] = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext('citame.whatsapp.connection')) as locked`,
  );
  if (!lock?.locked) throw new DomainError("invalid_state", "Ya hay una conexión en curso.");
}

export async function disconnectWhatsApp(db: Database, revision?: string) {
  await db.transaction(async (tx) => {
    await lockWhatsAppConnection(tx);
    await lockScheduling(tx);
    const current = await readConnection(tx, "update");
    if (!current) return;
    if (revision !== undefined && senderRevision(current) !== revision)
      throw new DomainError(
        "version_conflict",
        "La conexión de WhatsApp cambió. Revísela antes de desconectar.",
      );
    await disableWhatsApp(tx);
  });
}

export async function disableWhatsApp(db: Pick<Database, "delete" | "update">) {
  const rows = await db
    .delete(whatsappConnection)
    .where(eq(whatsappConnection.id, 1))
    .returning({ id: whatsappConnection.id });
  if (rows.length)
    await db
      .update(reminder)
      .set({ status: "cancelled", lockedUntil: null, lastError: "whatsapp_disconnected" })
      .where(
        and(
          eq(reminder.channel, "whatsapp"),
          inArray(reminder.status, ["pending", "processing"]),
          isNull(reminder.whatsappDispatchAt),
        ),
      );
}

export function mapRules(rules: WhatsAppRule[], templates: WhatsAppTemplate[]): SavedRule[] {
  return rules.map((rule) => {
    const template = templates.find((item) => item.id === rule.templateId);
    if (!template || template.parameters.length !== rule.variables.length)
      throw new DomainError(
        "validation_error",
        "Seleccione una plantilla de utilidad aprobada y asigne todas sus variables.",
      );
    return { ...rule, template };
  });
}

export function buildTemplateMessage(
  rule: SavedRule,
  to: string,
  notificationId: string,
  values: Record<WhatsAppRule["variables"][number], string>,
) {
  const { template, variables } = rule;
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.slice(1),
    type: "template",
    biz_opaque_callback_data: notificationId,
    template: {
      name: template.name,
      language: { code: template.language },
      ...(variables.length
        ? {
            components: [
              {
                type: "body",
                parameters: variables.map((variable, i) => ({
                  type: "text",
                  text: values[variable].replace(/\s+/g, " ").trim() || "—",
                  ...(template.named ? { parameter_name: template.parameters[i] } : {}),
                })),
              },
            ],
          }
        : {}),
    },
  };
}

export async function listTemplates(
  config: NotificationConfig,
  connection: NonNullable<Awaited<ReturnType<typeof readConnection>>>,
  request?: typeof fetch,
) {
  if (!config.whatsapp)
    throw new DomainError("invalid_state", "Meta WhatsApp no está configurado.");
  try {
    return await createMeta(config.whatsapp, request).templates(
      connection.wabaId,
      requestToken(config, connection),
    );
  } catch {
    throw new DomainError(
      "invalid_state",
      "No se pudieron consultar las plantillas. Compruebe la conexión en Meta.",
    );
  }
}
