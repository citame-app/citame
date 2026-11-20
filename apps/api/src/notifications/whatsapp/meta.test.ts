import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { supportedTemplate, tokenCipher } from "./meta";
import { signedMetaPayload } from "./routes";
import { buildTemplateMessage, mapRules } from "./service";

test("maps approved named body variables and rejects promotional templates", () => {
  const source = {
    id: "123456",
    name: "recordatorio_cita",
    language: "es_ES",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "NAMED",
    components: [{ type: "BODY", text: "Tu cita a las {{hora}} con {{profesional}}." }],
  };
  const template = supportedTemplate(source)!;
  expect(supportedTemplate({ ...source, category: "MARKETING" })).toBeNull();
  const [rule] = mapRules(
    [{ kind: "reminder_24h", templateId: template.id, variables: ["time", "staff"] }],
    [template],
  );
  expect(
    buildTemplateMessage(rule!, "+34600000001", "id", {
      client: "Lucía",
      salon: "Centro",
      date: "19/11",
      time: "16:00",
      staff: "Natalia",
      services: "Manicura",
      preferences: "enlace",
    }),
  ).toMatchObject({
    to: "34600000001",
    biz_opaque_callback_data: "id",
    template: {
      components: [
        {
          type: "body",
          parameters: [
            { text: "16:00", parameter_name: "hora" },
            { text: "Natalia", parameter_name: "profesional" },
          ],
        },
      ],
    },
  });
});

test("Graph secrets authenticate against the sender ID and signed webhooks cannot be altered", () => {
  const value = tokenCipher("secret", "123456").seal("meta-bearer-token");
  expect(value).not.toContain("meta-bearer-token");
  expect(tokenCipher("secret", "123456").open(value)).toBe("meta-bearer-token");
  expect(() => tokenCipher("secret", "876543").open(value)).toThrow();
  const payload = new TextEncoder().encode('{"entry":[]}');
  const signature = "sha256=" + createHmac("sha256", "secret").update(payload).digest("hex");
  expect(signedMetaPayload("secret", payload.buffer, signature)).toBe(true);
  payload[0] = 0;
  expect(signedMetaPayload("secret", payload.buffer, signature)).toBe(false);
});
