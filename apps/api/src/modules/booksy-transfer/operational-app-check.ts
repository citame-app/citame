import { randomBytes } from "node:crypto";
import {
  calendarResponseSchema,
  errorResponseSchema,
  meResponseSchema,
  salonResponseSchema,
} from "@sob/contracts";
import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { sql } from "drizzle-orm";
import { createApp } from "../../app";
import { createAccount } from "../../auth/accounts";
import { createAuth } from "../../auth/auth";
import { loadConfig } from "../../config";
import { createLogger } from "../../observability/logger";
import { findAvailability } from "../availability/service";
import { listServices } from "../services/service";
import { headSeq } from "../sync/pull";
import { booksyLocalDayBounds } from "./local-day";
import { isOperationalProbeDatabase, syncHistoryDigest } from "./operational-copy-check";
import {
  hydrateRehearsalDesktop,
  linkOperationalRehearsalDevice,
  openRehearsalSyncStream,
} from "./operational-desktop-check";
import { rehearseNativeCalendarMove } from "./operational-move-check";
import { fingerprint } from "./plan";

export class OperationalAppProofError extends Error {}

async function profileSnapshot(db: Database, through: number, syntheticId: string | null = null) {
  const [row] = await db.execute<{
    clients: string;
    history: string;
    appended: number;
    fixtureEvents: number;
  }>(sql`
    select
      (select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(c)::text, '' order by c.id), ''), 'UTF8')), 'hex')
       from public.client_profile c where c.id is distinct from ${syntheticId}::uuid) as clients,
      ${syncHistoryDigest(through)} as history,
      (select count(*)::int from public.sync_change where seq > ${through}) as appended,
      (select count(*)::int from public.sync_change
       where seq > ${through} and entity = 'client' and op = 'upsert' and row_id = ${syntheticId}) as "fixtureEvents"
  `);
  if (!row)
    throw new OperationalAppProofError(
      "The restored clients and sync history could not be verified",
    );
  return row;
}

async function availableBooking(db: Database, date: string, now: Date) {
  const services = (await listServices(db)).filter((service) => service.catalog?.kind !== "addon");
  const day = Temporal.PlainDate.from(date);
  for (let offset = 0; offset < 7; offset++) {
    for (const service of services) {
      const query = { date: day.add({ days: offset }).toString(), serviceIds: [service.id] };
      const {
        slots: [slot],
      } = await findAvailability(db, query, now);
      if (slot)
        return { staffId: slot.staffId, startsAt: slot.startsAt, serviceIds: query.serviceIds };
    }
  }
  throw new OperationalAppProofError("No available slot was found for the public booking test");
}

/** Only runs against the disposable native copy. Accounts and sessions are synthetic. */
export async function rehearseNativeBooksyApp(
  db: Database,
  valkey: RedisClient,
  date: string,
  expectedLines: number,
  options: { move?: { verifyBeforeWrite: () => Promise<void> } } = {},
) {
  const [settings] = await db.execute<{ database: string; timezone: string }>(sql`
    select current_database() as database, timezone from public.salon_settings where id = 1
  `);
  if (!settings || !isOperationalProbeDatabase(settings.database))
    throw new OperationalAppProofError("Application rehearsal requires the disposable native copy");
  const through = await headSeq(db);
  const before = await profileSnapshot(db, through);
  const { start, end } = booksyLocalDayBounds(date, settings.timezone);
  const now = new Date(start - 86_400_000);
  const range = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  const origin = "https://citame-rehearsal.example.test";
  const config = loadConfig({
    NODE_ENV: "production",
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
    VALKEY_KEY_PREFIX: `${settings.database}:`,
    SYNC_REPLICA_GENERATION: settings.database,
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    NOTIFY_EMAIL_PROVIDER: "none",
    NOTIFY_SMS_PROVIDER: "none",
    PAYMENT_PROVIDER: "none",
    MAINTENANCE_ENABLED: "false",
  });
  const app = createApp({
    db,
    valkey,
    config,
    emailProvider: null,
    paymentGateway: null,
    logger: createLogger({ write: () => {} }),
    now: () => now,
    syncHeartbeatMs: 100,
  });
  const request = (path: string, cookie?: string, body?: object, method = body ? "POST" : "GET") =>
    app.request(new URL(path, origin).href, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const credentials = (role: string) => ({
    email: `${role}-${randomBytes(8).toString("hex")}@example.test`,
    password: randomBytes(24).toString("hex"),
  });
  const cookieFrom = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie) => cookie && !cookie.endsWith("="))
      .join("; ");

  try {
    await app.ready();
    if ((await request("/ready")).status !== 200)
      throw new OperationalAppProofError("The native application readiness check failed");
    const owner = credentials("owner");
    const auth = createAuth({ db, valkey, config, emailProvider: null });
    try {
      await createAccount({ db, auth }, { ...owner, name: "Rehearsal owner", role: "owner" });
    } finally {
      await auth.mailer.stop();
    }
    const signedIn = await request("/api/auth/sign-in/email", undefined, owner);
    const ownerCookie = cookieFrom(signedIn);
    const session = signedIn.headers
      .getSetCookie()
      .find((cookie) => cookie.includes(".session_token="));
    const attributes =
      session
        ?.split(";")
        .slice(1)
        .map((field) => field.trim().toLowerCase()) ?? [];
    if (
      signedIn.status !== 200 ||
      !ownerCookie ||
      !session?.startsWith("__Secure-") ||
      !["secure", "httponly", "samesite=lax", "path=/"].every((name) => attributes.includes(name))
    )
      throw new OperationalAppProofError("The rehearsal owner could not obtain a secure session");
    const ownerProfile = meResponseSchema.safeParse(
      await (await request("/me", ownerCookie)).json(),
    );
    if (!ownerProfile.success || ownerProfile.data.user.role !== "owner")
      throw new OperationalAppProofError("The signed-in session did not have the owner role");
    const route = `/appointments/calendar?${new URLSearchParams(range)}`;
    if ((await request(route)).status !== 401)
      throw new OperationalAppProofError("The native calendar accepted an anonymous request");
    const response = await request(route, ownerCookie);
    if (response.status !== 200)
      throw new OperationalAppProofError("The owner could not read the native calendar");
    const calendar = calendarResponseSchema.safeParse(await response.json());
    if (
      !calendar.success ||
      calendar.data.importSnapshot ||
      calendar.data.timezone !== settings.timezone ||
      calendar.data.from !== range.from ||
      calendar.data.to !== range.to
    )
      throw new OperationalAppProofError(
        "The owner calendar did not return the native calendar contract",
      );
    const visits = calendar.data.appointments;
    const staff = await db.execute<{ id: string; displayName: string }>(sql`
      select id, display_name as "displayName" from public.staff_profile
      where active and deleted_at is null order by id
    `);
    const stored = await db.execute<{
      id: string;
      staffId: string;
      clientId: string;
      status: string;
      visitGroupId: string | null;
      startsAt: Date;
      endsAt: Date;
      services: [string | null, string, number, number][];
    }>(sql`
      select a.id, a.staff_id as "staffId", a.client_id as "clientId", a.status, a.visit_group_id as "visitGroupId",
        a.starts_at as "startsAt", a.ends_at as "endsAt",
        (select jsonb_agg(jsonb_build_array(s.service_id, s.name, s.duration_minutes, s.buffer_minutes) order by s.position)
         from public.appointment_service s where s.appointment_id = a.id) as services
      from public.appointment a
      where a.deleted_at is null and a.starts_at < ${new Date(end)} and a.ends_at > ${new Date(start)}
      order by a.id
    `);
    if (
      visits.length !== expectedLines ||
      visits.some((visit) => !visit.importedFromBooksy || visit.sourceCopy) ||
      fingerprint(calendar.data.staff.toSorted((a, b) => a.id.localeCompare(b.id))) !==
        fingerprint(staff) ||
      fingerprint(
        visits
          .map((visit) => ({
            id: visit.id,
            staffId: visit.staffId,
            clientId: visit.clientId,
            status: visit.status,
            visitGroupId: visit.visitGroupId ?? null,
            startsAt: new Date(visit.startsAt),
            endsAt: new Date(visit.endsAt),
            services: visit.services.map((service) => [
              service.serviceId,
              service.name,
              service.durationMinutes,
              service.bufferMinutes,
            ]),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ) !== fingerprint(stored)
    )
      throw new OperationalAppProofError(
        "The owner calendar differs from the restored appointments",
      );

    const salon = salonResponseSchema.safeParse(await (await request("/salon")).json());
    if (!salon.success || salon.data.onlineBookingEnabled !== false)
      throw new OperationalAppProofError("The public salon did not report booking as paused");
    const signup = await request("/api/auth/sign-up/email", undefined, {
      ...credentials("client"),
      name: "Rehearsal client",
    });
    const clientCookie = cookieFrom(signup);
    if (
      signup.status !== 200 ||
      !clientCookie ||
      (await request(route, clientCookie)).status !== 403
    )
      throw new OperationalAppProofError("The native calendar customer permission check failed");
    const client = meResponseSchema.safeParse(await (await request("/me", clientCookie)).json());
    if (!client.success || client.data.user.role !== "client" || !client.data.clientId)
      throw new OperationalAppProofError("The synthetic customer session has no client profile");
    const denied = await request(
      "/appointments",
      clientCookie,
      await availableBooking(db, date, now),
    );
    const error = errorResponseSchema.safeParse(await denied.json());
    if (
      denied.status !== 409 ||
      !error.success ||
      error.data.error.code !== "online_booking_paused"
    )
      throw new OperationalAppProofError(
        "The customer booking request was not blocked by the public pause",
      );
    const after = await profileSnapshot(db, through, client.data.clientId);
    if (
      after.clients !== before.clients ||
      after.history !== before.history ||
      after.appended !== 1 ||
      after.fixtureEvents !== 1
    )
      throw new OperationalAppProofError(
        "The application rehearsal changed existing clients or sync history",
      );
    let move: Awaited<ReturnType<typeof rehearseNativeCalendarMove>> | undefined;
    if (options.move) {
      await options.move.verifyBeforeWrite();
      const desktop = await linkOperationalRehearsalDevice(
        (url, init) => app.request(url, init),
        origin,
        ownerCookie,
        ownerProfile.data.user.id,
      );
      try {
        const generation = config.syncReplicaGeneration;
        const cursor = await hydrateRehearsalDesktop(desktop.get, generation, calendar.data);
        const stream = await openRehearsalSyncStream(desktop.get, generation, "Desktop");
        try {
          const startingHead = await stream.next();
          move = await rehearseNativeCalendarMove(
            db,
            (path, patch) => request(path, ownerCookie, patch, patch ? "PATCH" : "GET"),
            date,
            route,
            visits,
            { ...desktop, generation, cursor, stream, startingHead },
          );
        } finally {
          await stream.close();
        }
      } finally {
        await desktop.revoke();
      }
      const final = await profileSnapshot(db, through, client.data.clientId);
      if (final.clients !== before.clients || final.history !== before.history)
        throw new OperationalAppProofError(
          "The desktop rehearsal changed restored clients or prior sync history",
        );
    }
    return {
      ownerSignedIn: true,
      calendarLines: visits.length,
      serviceLines: visits.reduce((total, visit) => total + visit.services.length, 0),
      staffColumns: staff.length,
      anonymousCalendarDenied: true,
      customerCalendarDenied: true,
      customerBookingPaused: true,
      ...(move ? { move: { ...move, desktopDeviceLinkedAndRevoked: true } } : {}),
    };
  } finally {
    await app.shutdown();
  }
}
