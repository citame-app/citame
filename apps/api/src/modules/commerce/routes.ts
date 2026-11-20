import {
  cashAdjustmentSchema,
  cashCloseSchema,
  cashOpenSchema,
  checkoutPricesSchema,
  createCheckoutSchema,
  idSchema,
  permissionsFor,
  reconcileRefundSchema,
  refundRequestSchema,
  startPaymentSchema,
} from "@sob/contracts";
import { checkoutPayment } from "@sob/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../../app";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { errorBody, parseOrThrow, readJson } from "../../http";
import { recurringSettings } from "../../payments/recurring-settings";
import { InvalidBankNotificationError, RedsysGateway } from "../../payments/redsys";
import { checkoutRewardRoutes } from "../rewards/routes";
import { finalizeCheckoutPrices } from "./prices";
import {
  adjustCash,
  closeCashSession,
  createCheckout,
  currentCashSession,
  executeRefund,
  getCheckout,
  listCheckouts,
  manualRefund,
  openCashSession,
  receiveBankNotification,
  reconcilePayment,
  reconcileRefund,
  requireOperator,
  startPayment,
  voidCheckout,
} from "./service";

const operator = createMiddleware<AppEnv>(async (c, next) => {
  requireOperator(c.get("principal"));
  await next();
});
const checkoutId = (value: string) => parseOrThrow(idSchema, value);
function gatewayFor(deps: AppDeps) {
  if (deps.paymentGateway !== undefined) return deps.paymentGateway;
  return deps.config.payments.redsys ? new RedsysGateway(deps.config.payments.redsys) : null;
}

export function commerceAdminRoutes(deps: AppDeps) {
  const gateway = gatewayFor(deps);
  return new Hono<AppEnv>()
    .use("*", operator)
    .route("/checkouts", checkoutRewardRoutes(deps))
    .get("/capabilities", (c) =>
      c.json({
        permissions: permissionsFor(c.get("principal").role, c.get("principal").accessPreset),
        provider: deps.config.payments.provider,
        environment: gateway?.environment ?? null,
        card: Boolean(gateway),
        bizum: Boolean(gateway && deps.config.payments.bizumEnabled),
        currency: "EUR",
        giftCards: true,
        recurring: Boolean(recurringSettings(deps.config, gateway)),
      }),
    )
    .get("/checkouts", async (c) =>
      c.json({ checkouts: await listCheckouts(deps.db, c.get("principal")) }),
    )
    .post("/checkouts", async (c) =>
      c.json(
        await createCheckout(
          deps.db,
          parseOrThrow(createCheckoutSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/checkouts/:id", async (c) =>
      c.json(
        await getCheckout(
          deps.db,
          checkoutId(c.req.param("id")),
          c.get("principal"),
          deps.now?.() ?? new Date(),
        ),
      ),
    )
    .post("/checkouts/:id/void", async (c) =>
      c.json(await voidCheckout(deps.db, checkoutId(c.req.param("id")), c.get("principal"))),
    )
    .put("/checkouts/:id/prices", async (c) =>
      c.json(
        await finalizeCheckoutPrices(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(checkoutPricesSchema, await readJson(c)),
          c.get("principal"),
          deps.now?.() ?? new Date(),
        ),
      ),
    )
    .post("/checkouts/:id/payments", async (c) =>
      c.json(
        await startPayment(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(startPaymentSchema, await readJson(c)),
          c.get("principal"),
          gateway,
          deps.config.payments.bizumEnabled,
          recurringSettings(deps.config, gateway),
          deps.now?.() ?? new Date(),
        ),
        201,
      ),
    )
    .post("/payments/:id/refunds", async (c) =>
      c.json(
        await manualRefund(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(refundRequestSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .post("/payments/:id/reconcile", async (c) =>
      c.json(
        await reconcilePayment(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(reconcileRefundSchema, await readJson(c)),
          c.get("principal"),
          deps.now?.() ?? new Date(),
        ),
      ),
    )
    .post("/refunds/:id/execute", async (c) =>
      c.json(
        await executeRefund(deps.db, checkoutId(c.req.param("id")), c.get("principal"), gateway),
      ),
    )
    .post("/refunds/:id/reconcile", async (c) =>
      c.json(
        await reconcileRefund(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(reconcileRefundSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/cash-sessions/current", async (c) =>
      c.json({ session: await currentCashSession(deps.db, c.get("principal")) }),
    )
    .post("/cash-sessions", async (c) =>
      c.json(
        await openCashSession(
          deps.db,
          parseOrThrow(cashOpenSchema, await readJson(c)).openingCents,
          c.get("principal"),
        ),
        201,
      ),
    )
    .post("/cash-sessions/:id/close", async (c) =>
      c.json(
        await closeCashSession(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(cashCloseSchema, await readJson(c)).countedCents,
          c.get("principal"),
        ),
      ),
    )
    .post("/cash-sessions/adjust", async (c) =>
      c.json(
        await adjustCash(
          deps.db,
          parseOrThrow(cashAdjustmentSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    );
}
export function commerceClientRoutes(deps: AppDeps) {
  const gateway = gatewayFor(deps);
  return new Hono<AppEnv>()
    .route("/checkouts", checkoutRewardRoutes(deps))
    .get("/commerce/capabilities", (c) =>
      c.json({
        permissions: permissionsFor(c.get("principal").role, c.get("principal").accessPreset),
        provider: deps.config.payments.provider,
        environment: gateway?.environment ?? null,
        card: Boolean(gateway),
        bizum: Boolean(gateway && deps.config.payments.bizumEnabled),
        currency: "EUR",
        giftCards: true,
        recurring: Boolean(recurringSettings(deps.config, gateway)),
      }),
    )
    .post("/checkouts", async (c) =>
      c.json(
        await createCheckout(
          deps.db,
          parseOrThrow(createCheckoutSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/checkouts/:id", async (c) =>
      c.json(
        await getCheckout(
          deps.db,
          checkoutId(c.req.param("id")),
          c.get("principal"),
          deps.now?.() ?? new Date(),
        ),
      ),
    )
    .get("/payments/by-order/:order", async (c) => {
      const [payment] = await deps.db
        .select({ checkoutId: checkoutPayment.checkoutId })
        .from(checkoutPayment)
        .where(eq(checkoutPayment.bankOrder, c.req.param("order")));
      if (!payment) throw new DomainError("not_found", "Payment not found");
      return c.json(
        await getCheckout(
          deps.db,
          payment.checkoutId,
          c.get("principal"),
          deps.now?.() ?? new Date(),
        ),
      );
    })
    .post("/checkouts/:id/void", async (c) =>
      c.json(await voidCheckout(deps.db, checkoutId(c.req.param("id")), c.get("principal"))),
    )
    .post("/checkouts/:id/payments", async (c) =>
      c.json(
        await startPayment(
          deps.db,
          checkoutId(c.req.param("id")),
          parseOrThrow(startPaymentSchema, await readJson(c)),
          c.get("principal"),
          gateway,
          deps.config.payments.bizumEnabled,
          recurringSettings(deps.config, gateway),
          deps.now?.() ?? new Date(),
        ),
        201,
      ),
    );
}
/** Mounted before visitor rate limits: authentic bank retries must remain processable. */
export function redsysNotificationRoutes(deps: AppDeps) {
  const gateway = gatewayFor(deps);
  return new Hono().post("/redsys/notify", async (c) => {
    if (!gateway)
      return c.json(errorBody("payment_unavailable", "Online payments are not configured"), 503);
    try {
      const body = await c.req.text();
      if (body.length > 16000) throw new InvalidBankNotificationError();
      const params = new URLSearchParams(body);
      const fields: Record<string, unknown> = {};
      for (const [key, value] of params) {
        if (Object.hasOwn(fields, key)) throw new InvalidBankNotificationError();
        fields[key] = value;
      }
      await receiveBankNotification(
        deps.db,
        gateway,
        fields,
        recurringSettings(deps.config, gateway),
        deps.now?.() ?? new Date(),
      );
      return c.text("OK", 200);
    } catch (error) {
      // No provider payloads or error strings are logged: bank fields may contain personal data.
      if (
        !(error instanceof InvalidBankNotificationError) &&
        !(error instanceof DomainError && error.code === "validation_error")
      )
        throw error;
      return c.json(errorBody("validation_error", "Invalid payment notification"), 400);
    }
  });
}
