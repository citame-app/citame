import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type WhatsAppTemplate, whatsappTemplateSchema } from "@sob/contracts";
import { z } from "zod";
import type { WhatsAppConfig } from "../../config";

const assetId = z.string().regex(/^\d{5,32}$/);
const success = z.object({ success: z.literal(true) });
const businessToken = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().nonnegative().optional(),
});

export class MetaRequestError extends Error {
  constructor(public readonly status: number) {
    super("Meta no pudo completar la solicitud.");
  }
}

export function tokenCipher(secret: string, phoneId: string) {
  const key = createHash("sha256").update("citame-whatsapp-v1\0").update(secret).digest();
  const context = Buffer.from(phoneId);
  return {
    seal(token: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(context);
      return Buffer.concat([
        iv,
        cipher.update(token, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url");
    },
    open(value: string) {
      const buffer = Buffer.from(value, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12)).setAAD(context);
      cipher.setAuthTag(buffer.subarray(-16));
      return Buffer.concat([cipher.update(buffer.subarray(12, -16)), cipher.final()]).toString();
    },
  };
}

export function createMeta(config: WhatsAppConfig, request: typeof fetch = fetch) {
  async function graph(
    path: string,
    options: {
      token?: string;
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {},
  ): Promise<unknown> {
    const url = new URL(`https://graph.facebook.com/${config.version}/${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    try {
      const response = await request(url, {
        redirect: "error",
        method: options.body ? "POST" : "GET",
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new MetaRequestError(response.status);
      return await response.json();
    } catch (error) {
      // Never surface fetch errors or Graph responses. The OAuth URL contains credentials.
      throw error instanceof MetaRequestError ? error : new MetaRequestError(0);
    }
  }

  return {
    async exchange(code: string) {
      return businessToken.parse(
        await graph("oauth/access_token", {
          query: { client_id: config.appId, client_secret: config.appSecret, code },
        }),
      );
    },
    async phones(waba: string, token: string) {
      return z
        .object({
          data: z.array(
            z.object({
              id: assetId,
              display_phone_number: z.string(),
              is_on_biz_app: z.boolean().optional(),
              platform_type: z.string().optional(),
              status: z.string().optional(),
            }),
          ),
        })
        .parse(
          await graph(`${assetId.parse(waba)}/phone_numbers`, {
            token,
            query: {
              fields: "id,display_phone_number,is_on_biz_app,platform_type,status",
              limit: "100",
            },
          }),
        ).data;
    },
    async register(phone: string, token: string, pin: string) {
      success.parse(
        await graph(`${assetId.parse(phone)}/register`, {
          token,
          body: { messaging_product: "whatsapp", pin },
        }),
      );
    },
    async subscribe(waba: string, token: string, callback: string) {
      success.parse(
        await graph(`${assetId.parse(waba)}/subscribed_apps`, {
          token,
          body: { override_callback_uri: callback, verify_token: config.verifyToken },
        }),
      );
    },
    async templates(waba: string, token: string) {
      const templates: WhatsAppTemplate[] = [];
      let after: string | undefined;
      for (let index = 0; index < 20; index++) {
        const page = templatePage.parse(
          await graph(`${assetId.parse(waba)}/message_templates`, {
            token,
            query: {
              fields: "id,name,language,components,status,category,parameter_format",
              status: "APPROVED",
              category: "UTILITY",
              limit: "100",
              ...(after ? { after } : {}),
            },
          }),
        );
        templates.push(...page.data.flatMap((value) => supportedTemplate(value) ?? []));
        const next = page.paging?.next ? page.paging.cursors?.after : undefined;
        if (next && next === after) throw new MetaRequestError(502);
        if (!next || templates.length >= 1000) break;
        after = next;
      }
      return templates;
    },
    async send(phone: string, token: string, body: Record<string, unknown>) {
      return z
        .object({ messages: z.array(z.object({ id: z.string().min(1) })).nonempty() })
        .parse(await graph(`${assetId.parse(phone)}/messages`, { token, body })).messages[0]!.id;
    },
  };
}

const graphTemplate = z.object({
  id: assetId,
  name: z.string(),
  language: z.string(),
  status: z.string(),
  category: z.string(),
  parameter_format: z.string().optional(),
  components: z.array(
    z.object({
      type: z.string(),
      format: z.string().optional(),
      text: z.string().optional(),
    }),
  ),
});
const templatePage = z.object({
  data: z.array(graphTemplate),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});

export function supportedTemplate(
  template: z.infer<typeof graphTemplate>,
): WhatsAppTemplate | null {
  if (template.status !== "APPROVED" || template.category !== "UTILITY") return null;
  const body = template.components.find((part) => part.type === "BODY")?.text;
  if (
    body === undefined ||
    template.components.some(
      (part) =>
        part.type !== "BODY" &&
        ((part.type !== "HEADER" && part.type !== "FOOTER") ||
          (part.type === "HEADER" && part.format !== "TEXT") ||
          !part.text ||
          part.text.includes("{{")),
    )
  )
    return null;
  const parameters = [
    ...new Set([...body.matchAll(/{{\s*([a-z0-9_]+)\s*}}/g)].map((match) => match[1]!)),
  ];
  const named = template.parameter_format === "NAMED";
  if (
    named
      ? parameters.some((key) => !/^[a-z][a-z0-9_]*$/.test(key))
      : parameters.some((_, index) => !parameters.includes(String(index + 1)))
  )
    return null;
  const parsed = whatsappTemplateSchema.safeParse({
    id: template.id,
    name: template.name,
    language: template.language,
    body,
    parameters: named ? parameters : parameters.sort((a, b) => +a - +b),
    named,
  });
  return parsed.success ? parsed.data : null;
}
