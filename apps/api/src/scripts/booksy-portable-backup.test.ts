import { expect, test } from "bun:test";
import { getReleaseMigrationLedger } from "@sob/db";
import { verifyPortableBooksyRehearsal } from "./booksy-portable-backup";

const snapshot = "a".repeat(64);
const ciphertext = "b".repeat(64);
const date = "2026-11-18";

test("recovery evidence is bound to the candidate, rehearsal day and full release ledger", () => {
  const migrations = getReleaseMigrationLedger();
  const receipt = {
    verifiedAt: "2026-11-18T17:16:41.626Z",
    snapshotHash: snapshot,
    encryptedSha256: ciphertext,
    tableContentSha256: "c".repeat(64),
    tables: 94,
    archiveArtifactsVerified: 1053,
    portableRestorationVerified: true,
    day: { date },
    candidate: { calendarLines: 787, products: 93, waitlistForReview: 2 },
    canCutOver: false,
    schedule: {
      date,
      migrations,
      migratedTables: 98,
      migratedTableContentSha256: "d".repeat(64),
      nativeProjectionVerifiedAfterMigration: true,
      allTableContentsUnchanged: true,
      rollbackVerified: true,
      replica: { calendarLines: 787 },
      professionalStartsRejected: 2,
      equipmentStartsRejected: 3,
      ordinaryStaffBooking: true,
      ordinaryEquipmentBooking: true,
      importedMovePreservedServiceAndContext: true,
      staleMoveRejected: true,
      ordinaryCheckoutMatchedFrozenPrice: true,
      waitlist: {
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
      },
      inventory: {
        status: "exercised",
        staleGenerationRejected: true,
        otherAccountRejected: true,
        staleVersionRejected: true,
        movementReplayRecordedOnce: true,
        modifiedReplayRejected: true,
        countBelowReservedRejected: true,
        countPreservedPackAndReservations: true,
        orderedLedgerPositionsVerified: true,
      },
    },
  };
  const expected = { snapshotHash: snapshot, encryptedSha256: ciphertext, date };
  expect(verifyPortableBooksyRehearsal(receipt, expected)).toMatchObject({
    recoveryEvidenceVerified: true,
    canCutOver: false,
    migrations,
  });
  expect(() =>
    verifyPortableBooksyRehearsal(receipt, { ...expected, snapshotHash: ciphertext }),
  ).toThrow("selected snapshot, encrypted backup or rehearsal day");
  expect(() =>
    verifyPortableBooksyRehearsal(receipt, { ...expected, encryptedSha256: snapshot }),
  ).toThrow("selected snapshot, encrypted backup or rehearsal day");
  expect(() => verifyPortableBooksyRehearsal(receipt, { ...expected, date: "2026-11-19" })).toThrow(
    "selected snapshot, encrypted backup or rehearsal day",
  );
  expect(() =>
    verifyPortableBooksyRehearsal(
      {
        ...receipt,
        schedule: { ...receipt.schedule, migrations: { ...migrations, ledgerSha256: snapshot } },
      },
      expected,
    ),
  ).toThrow("different migration ledger");
  for (const schedule of [
    undefined,
    { ...receipt.schedule, migrations: { ...migrations, ledgerSha256: undefined } },
    { ...receipt.schedule, allTableContentsUnchanged: false },
    { ...receipt.schedule, rollbackVerified: false },
    { ...receipt.schedule, ordinaryCheckoutMatchedFrozenPrice: false },
    { ...receipt.schedule, inventory: { status: "empty" } },
    {
      ...receipt.schedule,
      inventory: { ...receipt.schedule.inventory, movementReplayRecordedOnce: false },
    },
    {
      ...receipt.schedule,
      inventory: { ...receipt.schedule.inventory, orderedLedgerPositionsVerified: undefined },
    },
    { ...receipt.schedule, replica: { calendarLines: 786 } },
    { ...receipt.schedule, waitlist: undefined },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, preparedOnce: 1 } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, availableControls: 1 } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, enabledPolicyRejections: 1 } },
    {
      ...receipt.schedule,
      waitlist: { ...receipt.schedule.waitlist, missingStaffPreferenceRejections: 1 },
    },
    {
      ...receipt.schedule,
      waitlist: { ...receipt.schedule.waitlist, replaysWhileEnabled: undefined },
    },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, replaysWhileEnabled: 1 } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, anyProfessionalAccepted: 1 } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, entriesScanned: undefined } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, entriesScanned: 1 } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, policyPaused: false } },
    { ...receipt.schedule, waitlist: { ...receipt.schedule.waitlist, offersCreated: 1 } },
  ]) {
    expect(() => verifyPortableBooksyRehearsal({ ...receipt, schedule }, expected)).toThrow(
      "successful migrated rehearsal",
    );
  }
  expect(
    verifyPortableBooksyRehearsal(
      {
        ...receipt,
        candidate: { ...receipt.candidate, products: 0 },
        schedule: { ...receipt.schedule, inventory: { status: "empty" } },
      },
      expected,
    ),
  ).toMatchObject({ recoveryEvidenceVerified: true, inventory: { status: "empty" } });
});
