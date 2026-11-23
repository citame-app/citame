import { createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  DESKTOP_CLIENT_ID,
  DESKTOP_SIGN_IN_SCOPE,
  desktopDeviceLinkResponseSchema,
  desktopReceiptDestinationSchema,
  desktopWorkspaceSchema,
} from "@sob/contracts";
import { type Database, desktopDevice, oauthClient, session } from "@sob/db";
import type { RedisClient } from "bun";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { recordAudit } from "../audit";
import { requireRole } from "../auth/policy";
import { type AppEnv, loadPrincipal, type Principal } from "../auth/principal";
import type { AppConfig } from "../config";
import { DomainError } from "../errors";
import { parseOrThrow, readJson } from "../http";
import { BearerError, type TokenVerifier } from "../mcp/verify";
import { receiptHasHostedOrder, saleRow } from "../modules/commerce/service";
import { desktopResource } from "./desktop";
import { desktopWorkspacePath } from "./desktop-workspaces";

const tokenPrefix = "cd1.";
export const isDesktopDeviceBearer = (header: string | undefined) =>
  /^Bearer\s+cd1\./i.test(header ?? "");
const deviceId = z.uuid();
const base64url = /^[A-Za-z0-9_-]+$/;
const enrollment = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  publicKey: z.string().length(43).regex(base64url),
});
const proof = z.object({
  deviceId,
  issuedAt: z.number().int(),
  nonce: z.string().length(43).regex(base64url),
  signature: z.string().length(86).regex(base64url),
});
const loopbackOrigin = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
  .refine((origin) => {
    try {
      return new URL(origin).origin === origin;
    } catch {
      return false;
    }
  });
const calendarTarget = z.object({
  date: z.iso.date(),
  view: z.enum(["day", "week", "month", "list", "resources"]),
  staff: z
    .string()
    .min(36)
    .max(3699)
    .refine((input) => {
      const ids = input.split(",");
      return ids.length <= 100 && ids.every((id) => deviceId.safeParse(id).success);
    })
    .optional(),
});
const calendarDestination = { calendar: calendarTarget };
const workspaceDestination = { workspace: desktopWorkspaceSchema };
const receiptDestination = desktopReceiptDestinationSchema.shape;
const browserOrigin = { origin: loopbackOrigin, proof: proof.optional() };
const browserRequest = z.union([
  z.strictObject({ ...browserOrigin, ...calendarDestination }),
  z.strictObject({ ...browserOrigin, ...workspaceDestination }),
  z.strictObject({ ...browserOrigin, ...receiptDestination }),
]);
const browserSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), id: deviceId }),
  z.object({ kind: z.literal("session"), id: z.string() }),
]);
const savedBrowserTicket = z.union([
  z.strictObject({ source: browserSource, ...calendarDestination }),
  z.strictObject({ source: browserSource, ...workspaceDestination }),
  z.strictObject({ source: browserSource, ...receiptDestination }),
]);

async function browserPath(
  db: Database,
  saved: z.infer<typeof savedBrowserTicket>,
  principal: Principal,
) {
  if ("workspace" in saved) return desktopWorkspacePath(saved.workspace, principal);
  if ("receipt" in saved) {
    const sales = desktopWorkspacePath("sales", principal);
    if (!sales) return null;
    try {
      await saleRow(db, saved.receipt, principal);
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") return null;
      throw error;
    }
    const query = new URLSearchParams({ checkout: saved.receipt });
    if (saved.bankPayment) {
      if (!(await receiptHasHostedOrder(db, saved.receipt, saved.bankPayment))) return null;
      query.set("bankPayment", saved.bankPayment);
    }
    return `${sales}?${query}`;
  }
  const query = new URLSearchParams({ date: saved.calendar.date, view: saved.calendar.view });
  if (saved.calendar.staff) query.set("staff", saved.calendar.staff);
  return `/admin/calendar?${query}`;
}
const handoffTicket = z.string().length(43).regex(base64url);
const proofWindowSeconds = 120;
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const invalidBearer = () => new BearerError("invalid_token", "Invalid device authorization");
type Device = typeof desktopDevice.$inferSelect;

function publicKey(encoded: string) {
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== encoded)
    throw new DomainError("validation_error", "Invalid device public key");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

async function revoke(db: Database, id: string, userId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(desktopDevice)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(desktopDevice.id, id),
          eq(desktopDevice.userId, userId),
          isNull(desktopDevice.revokedAt),
        ),
      )
      .returning({ id: desktopDevice.id });
    if (row)
      await recordAudit(tx, {
        actorUserId: userId,
        action: "oauth.desktop_device_revoked",
        entity: "desktop_device",
        entityId: row.id,
      });
  });
}

export function desktopDeviceAccountRoutes(db: Database) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      requireRole(c.get("principal"), "owner", "staff");
      await next();
    })
    .get("/", async (c) => {
      const rows = await db
        .select({
          id: desktopDevice.id,
          label: desktopDevice.label,
          linkedAt: desktopDevice.linkedAt,
          lastSeenAt: desktopDevice.lastSeenAt,
        })
        .from(desktopDevice)
        .where(
          and(eq(desktopDevice.userId, c.get("principal").userId), isNull(desktopDevice.revokedAt)),
        )
        .orderBy(desc(desktopDevice.lastSeenAt), desc(desktopDevice.id));
      return c.json({ devices: rows });
    })
    .delete("/:deviceId", async (c) => {
      await revoke(db, parseOrThrow(deviceId, c.req.param("deviceId")), c.get("principal").userId);
      return c.body(null, 204);
    });
}

export function createDesktopDevices({
  db,
  valkey,
  config,
  oauth,
  currentBrowserSession,
  browserSession,
}: {
  db: Database;
  valkey: RedisClient;
  config: AppConfig;
  oauth: TokenVerifier;
  currentBrowserSession: (headers: Headers) => Promise<string | undefined>;
  browserSession: (userId: string) => Promise<Response>;
}) {
  const resource = desktopResource(config.auth.baseURL);
  const secret = createHmac("sha256", config.auth.secret)
    .update("citame:desktop:access:v1")
    .digest();
  const expiresIn = config.oauth.accessTokenTtlSeconds;

  async function activePrincipal(device: Device) {
    const [client] = await db
      .select({ disabled: oauthClient.disabled })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, DESKTOP_CLIENT_ID));
    if (!client || client.disabled || device.revokedAt) return null;
    const principal = await loadPrincipal(db, device.userId);
    return principal?.role === "owner" || principal?.role === "staff" ? principal : null;
  }

  async function findDevice(id: string) {
    const [device] = await db.select().from(desktopDevice).where(eq(desktopDevice.id, id));
    return device;
  }

  async function browserPrincipal(source: z.infer<typeof browserSource>) {
    if (source.kind === "device") {
      const device = await findDevice(source.id);
      return device ? activePrincipal(device) : null;
    }
    const [current] = await db
      .select({ userId: session.userId })
      .from(session)
      .where(and(eq(session.id, source.id), gt(session.expiresAt, new Date())));
    const principal = current ? await loadPrincipal(db, current.userId) : null;
    return principal?.role === "owner" || principal?.role === "staff" ? principal : null;
  }

  async function verifyProof(
    action: "token" | "revoke" | "browser-ticket",
    input: z.infer<typeof proof>,
    binding: string[] = [],
  ) {
    const device = await findDevice(input.deviceId);
    if (!device || device.revokedAt) throw new DomainError("not_found", "Device disconnected");
    const now = Math.floor(Date.now() / 1000);
    const message = [
      "citame-desktop-v1",
      resource,
      device.id,
      action,
      input.issuedAt,
      input.nonce,
      ...binding,
    ].join("\n");
    if (
      Math.abs(now - input.issuedAt) > proofWindowSeconds ||
      !verify(
        null,
        Buffer.from(message),
        publicKey(device.publicKey),
        Buffer.from(input.signature, "base64url"),
      )
    )
      throw new DomainError("unauthorized", "Invalid device proof");
    // Consume a signed nonce once across API replicas, for the entire proof validity window.
    const used = await valkey.send("SET", [
      `${config.valkeyKeyPrefix}:desktop-proof:${device.id}:${input.nonce}`,
      "1",
      "NX",
      "EX",
      String(proofWindowSeconds * 2 + 1),
    ]);
    if (used !== "OK") throw new DomainError("unauthorized", "Invalid device proof");
    return device;
  }

  const browserTicketKey = (origin: string, ticket: string) =>
    `${config.valkeyKeyPrefix}:desktop-browser:${createHash("sha256").update(origin).update(":").update(ticket).digest("hex")}`;

  const verifier: TokenVerifier = {
    async verify(header) {
      const token = /^Bearer\s+cd1\.(\S+)$/i.exec(header ?? "")?.[1];
      if (!token) {
        const legacy = await oauth.verify(header);
        // OAuth tokens from the current native client are for enrollment only.
        if (!legacy.scopes.includes("offline_access")) throw invalidBearer();
        return legacy;
      }
      const payload = await jwtVerify(token, secret, {
        issuer: resource,
        audience: resource,
        algorithms: ["HS256"],
        typ: "citame-device+jwt",
        requiredClaims: ["exp", "iat", "sub", "device"],
      }).then(
        ({ payload }) => payload,
        () => {
          throw invalidBearer();
        },
      );
      const id = deviceId.safeParse(payload.device);
      if (!id.success) throw invalidBearer();
      const device = await findDevice(id.data);
      if (!device || device.userId !== payload.sub) throw invalidBearer();
      const principal = await activePrincipal(device);
      if (!principal) throw invalidBearer();
      return { clientId: DESKTOP_CLIENT_ID, scopes: [DESKTOP_SIGN_IN_SCOPE], principal };
    },
  };

  const routes = new Hono()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .post("/browser-ticket", async (c) => {
      const input = parseOrThrow(browserRequest, await readJson(c));
      const { origin } = input;
      let source: z.infer<typeof browserSource>;
      if (input.proof) {
        const binding =
          "workspace" in input
            ? [origin, "workspace", input.workspace]
            : "receipt" in input
              ? [
                  origin,
                  "receipt",
                  input.receipt,
                  ...(input.bankPayment ? ["bank-payment", input.bankPayment] : []),
                ]
              : [origin, input.calendar.date, input.calendar.view, input.calendar.staff ?? ""];
        const device = await verifyProof("browser-ticket", input.proof, binding);
        source = { kind: "device", id: device.id };
      } else {
        if (c.req.header("origin") !== new URL(config.auth.baseURL).origin)
          throw new DomainError("forbidden", "Invalid browser handoff");
        const sessionId = await currentBrowserSession(c.req.raw.headers);
        if (!sessionId) throw new DomainError("unauthorized", "Browser handoff requires a session");
        source = { kind: "session", id: sessionId };
      }
      const { origin: _origin, proof: _proof, ...destination } = input;
      const saved = { source, ...destination };
      const principal = await browserPrincipal(source);
      if (!principal || !(await browserPath(db, saved, principal)))
        throw new DomainError("forbidden", "Access denied");
      const ticket = randomBytes(32).toString("base64url");
      await valkey.send("SET", [
        browserTicketKey(input.origin, ticket),
        JSON.stringify(saved),
        "EX",
        "60",
      ]);
      return c.json({ ticket });
    })
    .post("/browser", async (c) => {
      const origin = loopbackOrigin.safeParse(c.req.header("origin"));
      if (
        !origin.success ||
        c.req.header("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded"
      )
        throw new DomainError("forbidden", "Invalid browser handoff");
      c.header("Referrer-Policy", "no-referrer");
      const body = await c.req.formData().catch(() => null);
      const ticket = handoffTicket.safeParse(body?.get("ticket"));
      if (!ticket.success) throw new DomainError("unauthorized", "Invalid browser handoff");
      const serialized = await valkey.send("GETDEL", [browserTicketKey(origin.data, ticket.data)]);
      if (typeof serialized !== "string")
        throw new DomainError("unauthorized", "Expired browser handoff");
      const saved = savedBrowserTicket.parse(JSON.parse(serialized));
      const principal = await browserPrincipal(saved.source);
      const path = principal && (await browserPath(db, saved, principal));
      if (!path) throw new DomainError("forbidden", "Access denied");
      const response = await browserSession(principal.userId);
      if (!response.ok) return response;
      for (const cookie of response.headers.getSetCookie())
        c.header("Set-Cookie", cookie, { append: true });
      return c.redirect(path, 303);
    })
    .post("/link", async (c) => {
      const input = parseOrThrow(enrollment, await readJson(c));
      publicKey(input.publicKey);
      const identity = await oauth.verify(c.req.header("authorization")).catch((error: unknown) => {
        if (!(error instanceof BearerError)) throw error;
        throw new DomainError("unauthorized", "Invalid desktop authorization");
      });
      if (
        identity.clientId !== DESKTOP_CLIENT_ID ||
        !identity.scopes.includes(DESKTOP_SIGN_IN_SCOPE) ||
        !identity.grantId ||
        !identity.tokenId
      )
        throw new DomainError("forbidden", "A desktop authorization is required");
      requireRole(identity.principal, "owner", "staff");
      const { grantId, tokenId: enrollmentId } = identity;
      const userId = identity.principal.userId;
      const device = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(desktopDevice)
          .values({ ...input, enrollmentId, userId, grantId })
          .onConflictDoNothing({ target: desktopDevice.enrollmentId })
          .returning();
        if (created) {
          await recordAudit(tx, {
            actorUserId: userId,
            action: "oauth.desktop_device_linked",
            entity: "desktop_device",
            entityId: created.id,
          });
          return created;
        }
        const [existing] = await tx
          .select()
          .from(desktopDevice)
          .where(eq(desktopDevice.enrollmentId, enrollmentId));
        return existing;
      });
      if (
        !device ||
        device.userId !== userId ||
        device.publicKey !== input.publicKey ||
        device.revokedAt
      )
        throw new DomainError("forbidden", "This authorization has already been used");
      // Enrollment returns an identifier only. Issuing a bearer also requires proof of key ownership.
      return c.json(desktopDeviceLinkResponseSchema.parse({ deviceId: device.id }));
    })
    .post("/token", async (c) => {
      const device = await verifyProof("token", parseOrThrow(proof, await readJson(c)));
      if (!(await activePrincipal(device)))
        throw new DomainError("forbidden", "Device access denied");
      const [updated] = await db
        .update(desktopDevice)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(desktopDevice.id, device.id), isNull(desktopDevice.revokedAt)))
        .returning({ id: desktopDevice.id });
      if (!updated) throw new DomainError("not_found", "Device disconnected");
      const access = await new SignJWT({ device: device.id })
        .setProtectedHeader({ alg: "HS256", typ: "citame-device+jwt" })
        .setSubject(device.userId)
        .setIssuer(resource)
        .setAudience(resource)
        .setIssuedAt()
        .setExpirationTime(`${expiresIn}s`)
        .sign(secret);
      return c.json({
        access_token: tokenPrefix + access,
        expires_in: expiresIn,
        token_type: "Bearer",
      });
    })
    .post("/revoke", async (c) => {
      const device = await verifyProof("revoke", parseOrThrow(proof, await readJson(c)));
      await revoke(db, device.id, device.userId);
      return c.body(null, 204);
    });

  return { routes, verifier };
}
