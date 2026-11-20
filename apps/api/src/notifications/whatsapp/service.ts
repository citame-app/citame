import {
  type WhatsAppRule,
  type WhatsAppTemplate,
  whatsappRuleSchema,
  whatsappTemplateSchema,
} from "@sob/contracts";
import { type Database, reminder, whatsappConnection } from "@sob/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import { createMeta, tokenCipher } from "./meta";

const savedRule = whatsappRuleSchema.extend({ template: whatsappTemplateSchema });
const savedRules = z.array(savedRule);
type SavedRule = z.infer<typeof savedRule>;

export async function readConnection(db: Pick<Database, "select">, lock?: "share") {
  const query = db.select().from(whatsappConnection).where(eq(whatsappConnection.id, 1));
  const [connection] = await (lock ? query.for(lock) : query);
  return connection;
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
          coexistence: connection.coexistence,
          rules: savedRules
            .parse(connection.rules)
            .map(({ kind, templateId, variables }) => ({ kind, templateId, variables })),
          expiresAt: connection.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
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
