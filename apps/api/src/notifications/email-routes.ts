import {
  emailDeliveryInputSchema,
  emailDeliverySettingsSchema,
  emailDeliveryTestInputSchema,
  emailDeliveryTestReceiptSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps } from "../app";
import { recordAudit } from "../audit";
import { requireRole } from "../auth/policy";
import type { AppEnv } from "../auth/principal";
import { DomainError } from "../errors";
import { errorBody, parseOrThrow, readJson } from "../http";
import type { RateLimiter } from "../rate-limit";
import { getEmailDelivery, resolveNotificationEmail, updateEmailDelivery } from "./email-delivery";
import { createProviders } from "./providers";

export function emailDeliveryRoutes(
  { db, config, emailFetch, disableEmailDeliveryTest }: AppDeps,
  limiter: RateLimiter,
) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/", async (c) =>
      c.json(emailDeliverySettingsSchema.parse(await getEmailDelivery(db, config.notifications))),
    )
    .put("/", bodyLimit({ maxSize: 4096 }), async (c) => {
      const input = parseOrThrow(emailDeliveryInputSchema, await readJson(c));
      return c.json(
        await updateEmailDelivery(db, config.notifications, c.get("principal").userId, input),
      );
    })
    .post("/test", bodyLimit({ maxSize: 4096 }), async (c) => {
      if (disableEmailDeliveryTest)
        throw new DomainError("forbidden", "Los envíos están desactivados en las pruebas locales.");
      const { revision } = c.req.header("content-type")?.startsWith("application/json")
        ? parseOrThrow(emailDeliveryTestInputSchema, await readJson(c))
        : {};
      const { email, userId } = c.get("principal");
      const budget = await limiter.hit("email-delivery-test", userId, {
        max: 3,
        windowSeconds: 60,
      });
      if (!budget.allowed) {
        c.header("Retry-After", String(budget.retryAfterSeconds));
        return c.json(errorBody("rate_limited", "Too many email tests; try again later"), 429);
      }
      const fallback = createProviders(config.notifications).email;
      try {
        const provider = await resolveNotificationEmail(
          db,
          config.notifications,
          fallback,
          emailFetch,
          revision,
        );
        if (!provider) throw new DomainError("invalid_state", "Email delivery is disabled");
        try {
          await provider.send({
            to: email,
            subject: "Citame · Prueba de correo / Email test",
            text: "Citame pudo enviar un correo con esta configuración. Citame could send email with these settings.",
            html: "<p>Citame pudo enviar un correo con esta configuración.</p><p>Citame could send email with these settings.</p>",
            idempotencyKey: Bun.randomUUIDv7(),
          });
        } catch {
          throw new DomainError(
            "invalid_state",
            "The email provider did not accept the test message",
          );
        }
      } finally {
        await fallback?.close?.();
      }
      await recordAudit(db, {
        actorUserId: userId,
        action: "notification.email_test_sent",
        entity: "email_delivery",
      });
      return c.json(emailDeliveryTestReceiptSchema.parse({ ok: true }));
    });
}
