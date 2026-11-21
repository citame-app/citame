import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  appointment,
  appointmentContext,
  appointmentService,
  createDb,
  DEFAULT_DATABASE_URL,
  dbOptionsFromEnv,
  resourcePool,
  resourceReservation,
  runMigrations,
  serviceResource,
} from "@sob/db";
import { sql } from "drizzle-orm";
import { MONDAY, MONDAY_0900, seedFixtures } from "../../../test/helpers";
import { createTestValkey } from "../../../test/valkey";
import { rehearseNativeBooksyApp } from "./operational-app-check";
import { operationalProbePrefix, pauseBooksyCopyBooking } from "./operational-copy-check";

test("the native rehearsal can optionally move a resource-backed imported appointment", async () => {
  const name = `${operationalProbePrefix}${randomBytes(8).toString("hex")}`;
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  // PostgreSQL may wait for a checkpoint while dropping a database under parallel test load.
  const admin = createDb(url.href, { ...dbOptionsFromEnv(), statementTimeoutMs: 30_000 });
  const cache = await createTestValkey("booksy-operational-app");
  try {
    await admin.db.execute(sql`create database ${sql.identifier(name)}`);
    url.pathname = `/${name}`;
    const copy = createDb(url.href);
    try {
      await runMigrations(copy.db);
      const fixture = await seedFixtures(copy.db);
      const [visit] = await copy.db
        .insert(appointment)
        .values({
          clientId: fixture.clientId,
          staffId: fixture.anaId,
          startsAt: new Date(MONDAY_0900),
          endsAt: new Date("2026-03-09T13:00:00Z"),
          status: "booked",
          visitGroupId: Bun.randomUUIDv7(),
        })
        .returning();
      if (!visit) throw new Error("Expected a synthetic imported appointment");
      await copy.db.insert(appointmentService).values({
        appointmentId: visit.id,
        serviceId: fixture.haircutId,
        position: 0,
        name: "Haircut",
        durationMinutes: 45,
        bufferMinutes: 15,
        priceCents: 10000,
        currency: "EUR",
      });
      await copy.db.insert(appointmentContext).values({
        appointmentId: visit.id,
        servicePosition: 0,
        source: "booksy",
        sourceRef: "synthetic-operational-appointment",
      });
      const [equipment] = await copy.db
        .insert(resourcePool)
        .values({
          name: "Synthetic equipment",
          kind: "equipment",
          capacity: 1,
          idempotencyKey: "operational-move-equipment",
          requestHash: "synthetic",
        })
        .returning();
      if (!equipment) throw new Error("Expected synthetic equipment");
      await copy.db.insert(serviceResource).values({
        serviceId: fixture.haircutId,
        resourceId: equipment.id,
        quantity: 1,
      });
      await copy.db.insert(resourceReservation).values({
        name: equipment.name,
        appointmentId: visit.id,
        resourceId: equipment.id,
        servicePosition: 0,
        unitIndex: 0,
        offsetMinutes: 0,
        endOffsetMinutes: 60,
        startsAt: visit.startsAt,
        endsAt: visit.endsAt,
      });
      await pauseBooksyCopyBooking(copy.db);
      expect(
        await rehearseNativeBooksyApp(copy.db, cache.client, MONDAY, 1, {
          move: {
            verifyBeforeWrite: async () => {
              expect(await copy.db.select().from(appointment)).toEqual([visit]);
            },
          },
        }),
      ).toMatchObject({
        ownerSignedIn: true,
        calendarLines: 1,
        serviceLines: 1,
        staffColumns: 2,
        anonymousCalendarDenied: true,
        customerCalendarDenied: true,
        customerBookingPaused: true,
        move: {
          movedThroughApi: true,
          staleVersionRejected: true,
          resourceAssignments: 1,
          calendarUpdated: true,
          replicaUpdated: true,
          deviceProofRenewed: true,
          desktopLiveChangeReceived: true,
          desktopDeviceLinkedAndRevoked: true,
        },
      });
      const [moved] = await copy.db.select().from(appointment);
      expect(moved).toMatchObject({ id: visit.id, version: visit.version + 1 });
      expect(moved?.startsAt).not.toEqual(visit.startsAt);
    } finally {
      await copy.close();
      // The test owns this randomly named database. Drain any session still closing after SSE.
      await admin.db.execute(sql`drop database if exists ${sql.identifier(name)} with (force)`);
    }
  } finally {
    await Promise.all([admin.close(), cache.close()]);
  }
}, 50_000);
