import { expect, test } from "bun:test";
import {
  clientProfile,
  reminder,
  salonSettings,
  user,
  waitlistEntry,
  waitlistOffer,
  waitlistPolicy,
  waitlistSourceEntry,
} from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import type { Principal } from "../../auth/principal";
import { checkRestoredWaitlist } from "./waitlist-check";

test("the restored waitlist rehearsal preserves originals and rolls back synthetic preparation", async () => {
  const database = await createTestDatabase("booksy_restored_waitlist");
  try {
    await database.reset();
    const { db } = database;
    const operator: Principal = {
      userId: Bun.randomUUIDv7(),
      role: "owner",
      name: "Synthetic waitlist operator",
      email: "waitlist-recovery@example.invalid",
      staffId: null,
      clientId: null,
    };
    await db.insert(user).values({
      id: operator.userId,
      role: operator.role,
      name: operator.name,
      email: operator.email,
    });
    await db
      .insert(salonSettings)
      .values({
        name: "Synthetic recovery salon",
        timezone: "Europe/Madrid",
      })
      .onConflictDoNothing();
    const empty = await db.transaction((tx) => checkRestoredWaitlist(tx, operator));
    expect(empty).toMatchObject({
      sourceRequests: 0,
      preparedOnce: 0,
      enabledPolicyRejections: 0,
      missingStaffPreferenceRejections: 0,
      anyProfessionalAccepted: 0,
      replaysWhileEnabled: 0,
      policyPaused: true,
      entriesScanned: 0,
    });
    const [client] = await db
      .insert(clientProfile)
      .values({ name: "Synthetic imported customer" })
      .returning({ id: clientProfile.id });
    if (!client) throw new Error("Missing synthetic imported customer");
    await db.insert(waitlistSourceEntry).values(
      [60, 90].map((durationMinutes, sourceOrder) => ({
        id: Bun.randomUUIDv7(),
        clientId: client.id,
        requestedDate: "2026-11-18",
        durationMinutes,
        flexible: sourceOrder === 0,
        sourceOrder,
        sourceHash: "a".repeat(64),
        capturedAt: new Date("2026-11-17T22:30:00Z"),
      })),
    );
    const originals = await db.select().from(waitlistSourceEntry);
    const rollback = new Error("End waitlist rehearsal");
    await expect(
      db.transaction(async (tx) => {
        expect(await checkRestoredWaitlist(tx, operator)).toEqual({
          sourceRequests: 2,
          preparedOnce: 2,
          availableControls: 2,
          enabledPolicyRejections: 2,
          missingStaffPreferenceRejections: 2,
          anyProfessionalAccepted: 2,
          replaysWhileEnabled: 2,
          originalsUnchanged: true,
          policyPaused: true,
          entriesScanned: 0,
          offersCreated: 0,
          remindersCreated: 0,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select().from(waitlistSourceEntry)).toEqual(originals);
    expect(await db.select().from(waitlistEntry)).toHaveLength(0);
    expect(await db.select().from(waitlistOffer)).toHaveLength(0);
    expect(await db.select().from(reminder)).toHaveLength(0);
    expect(await db.select().from(waitlistPolicy)).toHaveLength(0);
    await db
      .insert(waitlistPolicy)
      .values({ id: 1, terms: { enabled: true, offerMinutes: 30 } })
      .onConflictDoUpdate({
        target: waitlistPolicy.id,
        set: { terms: { enabled: true, offerMinutes: 30 } },
      });
    await expect(db.transaction((tx) => checkRestoredWaitlist(tx, operator))).rejects.toThrow(
      "must keep waitlist offers paused",
    );
    expect(await db.select().from(waitlistSourceEntry)).toEqual(originals);
  } finally {
    await database.close();
  }
});
