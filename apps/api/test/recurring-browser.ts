/** Explicit test executable; it is never imported by the production entry point. */

import {
  appointment,
  appointmentService,
  clientProfile,
  passContract,
  passPeriod,
  service,
  staffProfile,
  waitlistOffer,
} from "@sob/db";
import { seedSampleData } from "@sob/db/seed";
import { createTestDatabase } from "@sob/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth/accounts";
import { createAuth } from "../src/auth/auth";
import { loadConfig } from "../src/config";
import { runMembershipBilling } from "../src/modules/passes/billing";
import { runWaitlist } from "../src/modules/waitlist/matching";
import { RedsysGateway, redsysSignature } from "../src/payments/redsys";
import type { PaymentGateway } from "../src/payments/types";
import { RECURRING_FIXTURE as fixture } from "./recurring-values";
import { createTestValkey } from "./valkey";

if (process.env.NODE_ENV !== "test") throw new Error("Recurring fixture requires NODE_ENV=test");
for (const value of [process.env.DATABASE_URL, process.env.VALKEY_URL])
  if (value && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname))
    throw new Error("Recurring fixture requires local test infrastructure");
const database = await createTestDatabase("recurring_browser");
await database.reset();
const valkey = await createTestValkey("recurring_browser");
const config = loadConfig({
  DATABASE_URL: database.url,
  VALKEY_KEY_PREFIX: valkey.prefix,
  BETTER_AUTH_SECRET: "local-recurring-fixture-secret-0123456789",
  BETTER_AUTH_URL: fixture.baseURL,
  TRUSTED_ORIGINS: fixture.baseURL,
  AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
  PAYMENT_PROVIDER: "redsys",
  REDSYS_MERCHANT_CODE: "999008881",
  REDSYS_TERMINAL: "001",
  REDSYS_SECRET_KEY: fixture.secret,
  REDSYS_RECURRING_ENABLED: "true",
  PAYMENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  RATE_LIMIT_AUTH_MAX: "100000",
  RATE_LIMIT_GLOBAL_MAX: "1000000",
});
await seedSampleData(database.db);
await database.db.update(service).set({ currency: "EUR" });
await database.db
  .update(service)
  .set({ currency: "EUR", priceCents: 2000 })
  .where(eq(service.id, fixture.haircut));
const auth = createAuth({ db: database.db, valkey: valkey.client, config });
await createAccount(
  { db: database.db, auth },
  { email: fixture.ownerEmail, name: "Fixture owner", password: fixture.password, role: "owner" },
);
await createAccount(
  { db: database.db, auth },
  {
    email: fixture.clientEmail,
    name: "Recurring fixture client",
    password: fixture.password,
    role: "client",
  },
);
await auth.mailer.stop();
if (process.env.E2E_REPUTATION_FIXTURE === "true" || process.env.E2E_SOCIAL_FIXTURE === "true") {
  const [client] = await database.db
    .select()
    .from(clientProfile)
    .where(eq(clientProfile.email, fixture.clientEmail));
  const [staff] = await database.db.select().from(staffProfile).limit(1);
  if (!client || !staff) throw new Error("Missing reputation fixture profiles");
  for (let day = 1; day <= 8; day++) {
    const startsAt = new Date(Date.now() - day * 86400000);
    const [visit] = await database.db
      .insert(appointment)
      .values({
        clientId: client.id,
        staffId: staff.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 1800000),
        status: "completed",
      })
      .returning();
    if (!visit) throw new Error("Missing reputation fixture visit");
    await database.db.insert(appointmentService).values({
      appointmentId: visit.id,
      serviceId: fixture.haircut,
      position: 0,
      name: "Fixture haircut",
      durationMinutes: 30,
      bufferMinutes: 0,
      priceCents: 2000,
      currency: "EUR",
    });
  }
}
const bank = new RedsysGateway(
  config.payments.redsys ?? {
    secret: fixture.secret,
    merchantCode: "999008881",
    terminal: "001",
    environment: "test",
    publicURL: fixture.baseURL,
    recurringEnabled: true,
  },
);
let bankCalls = 0;
const gateway: PaymentGateway = {
  provider: "redsys",
  environment: "test",
  supportsRecurring: true,
  checkout: (input) => bank.checkout(input),
  verify: (fields, type) => bank.verify(fields, type),
  refund: async (input) => ({
    ...input,
    currency: "EUR",
    transactionType: "3",
    responseCode: "0900",
    success: true,
    authorizationCode: null,
  }),
  chargeRecurring: async (input) => {
    bankCalls++;
    const encoded = Buffer.from(
      JSON.stringify({
        Ds_Order: input.order,
        Ds_Amount: String(input.amountCents),
        Ds_Currency: "978",
        Ds_MerchantCode: "999008881",
        Ds_Terminal: "1",
        Ds_Response: "0000",
        Ds_TransactionType: "0",
      }),
    ).toString("base64url");
    return bank.verify({
      Ds_MerchantParameters: encoded,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: redsysSignature(fixture.secret, input.order, encoded),
    });
  },
};
const app = createApp({ db: database.db, valkey: valkey.client, config, paymentGateway: gateway });
await app.ready();
// This simulated hosted bank page verifies the outgoing form before issuing a signed callback.
app.post("/__recurring-fixture/settle", async (c) => {
  if (c.req.header("x-recurring-fixture") !== "local-only") return c.text("Not found", 404);
  const fields = await c.req.json<Record<string, string>>();
  const encoded = fields.Ds_MerchantParameters ?? "";
  const request = JSON.parse(Buffer.from(encoded, "base64url").toString());
  const order = String(request.DS_MERCHANT_ORDER ?? "");
  const deposit = c.req.header("x-fixture-purpose") === "deposit";
  if (
    fields.Ds_SignatureVersion !== "HMAC_SHA512_V2" ||
    fields.Ds_Signature !== redsysSignature(fixture.secret, order, encoded) ||
    (!deposit &&
      (request.DS_MERCHANT_IDENTIFIER !== "REQUIRED" ||
        request.DS_MERCHANT_COF_INI !== "S" ||
        request.DS_MERCHANT_COF_TYPE !== "R")) ||
    (deposit && request.DS_MERCHANT_IDENTIFIER !== undefined)
  )
    return c.text("Invalid fixture bank request", 400);
  const expiry = `${String(new Date().getUTCFullYear() + 2).slice(-2)}12`;
  const payload = Buffer.from(
    JSON.stringify({
      Ds_Order: order,
      Ds_Amount: request.DS_MERCHANT_AMOUNT,
      Ds_Currency: "978",
      Ds_MerchantCode: "999008881",
      Ds_Terminal: "1",
      Ds_Response: "0000",
      Ds_TransactionType: "0",
      ...(!deposit
        ? {
            Ds_Merchant_Identifier: fixture.reference,
            Ds_Merchant_Cof_Txnid: "2006031152000",
            Ds_ExpiryDate: expiry,
            Ds_Card_Last4: "0003",
          }
        : {}),
    }),
  ).toString("base64url");
  const response = await app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Ds_MerchantParameters: payload,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: redsysSignature(fixture.secret, order, payload),
    }),
  });
  return c.json({ order }, response.status === 200 ? 200 : 400);
});
// Advance only the requested fixture contract. No simulated payment reaches a bank transport.
app.post("/__recurring-fixture/billing", async (c) => {
  if (c.req.header("x-recurring-fixture") !== "local-only") return c.text("Not found", 404);
  const body = await c.req.json<{ contractId: string; advance?: boolean }>();
  const now = new Date();
  if (body.advance) {
    const anchor = new Date(
      Temporal.Instant.from(now.toISOString())
        .toZonedDateTimeISO("America/Argentina/Buenos_Aires")
        .subtract({ months: 1 }).epochMilliseconds,
    );
    await database.db
      .update(passContract)
      .set({ anchorAt: anchor })
      .where(eq(passContract.id, body.contractId));
    const [period] = await database.db
      .select()
      .from(passPeriod)
      .where(eq(passPeriod.contractId, body.contractId))
      .limit(1);
    if (period)
      await database.db
        .update(passPeriod)
        .set({ startsAt: anchor, endsAt: new Date(now.getTime() - 1) })
        .where(eq(passPeriod.id, period.id));
  }
  const result = await runMembershipBilling({ db: database.db, config, gateway, now: () => now });
  return c.json({ ...result, bankCalls });
});
app.post("/__recurring-fixture/waitlist/run", async (c) => {
  if (c.req.header("x-recurring-fixture") !== "local-only") return c.text("Not found", 404);
  const body = await c.req.json<{ expireOfferId?: string }>();
  if (body.expireOfferId)
    await database.db
      .update(waitlistOffer)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(waitlistOffer.id, body.expireOfferId));
  return c.json(await runWaitlist(database.db));
});
const server = Bun.serve({ hostname: "127.0.0.1", port: fixture.apiPort, fetch: app.fetch });
console.log(`Recurring fixture listening on ${server.port}`);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.shutdown();
    await server.stop(true);
    await valkey.close();
    await database.close();
    process.exit(0);
  });
