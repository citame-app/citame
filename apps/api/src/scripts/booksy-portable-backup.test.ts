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

const operationalReference = { snapshotHash: snapshot, encryptedSha256: ciphertext, date };
const operationalWrite = {
  movedThroughApi: true,
  staleVersionRejected: true,
  resourceAssignments: 1,
  calendarUpdated: true,
  replicaUpdated: true,
  deviceProofRenewed: true,
  desktopLiveChangeReceived: true,
  movedThroughDesktop: true,
  webLiveChangeReceived: true,
  desktopReplayIdempotent: true,
  staleDesktopVersionRejected: true,
  desktopDeviceLinkedAndRevoked: true,
};

function operationalReceipt(move?: typeof operationalWrite) {
  return {
    verifiedAt: "2026-11-18T17:16:41.626Z",
    snapshotHash: snapshot,
    encryptedSha256: ciphertext,
    tableContentSha256: "c".repeat(64),
    tables: 94,
    archiveArtifactsVerified: 1053,
    portableRestorationVerified: true,
    day: { date, calendarLines: 26 },
    candidate: { calendarLines: 787, staff: 7, services: 187, frozenServices: 817 },
    canCutOver: false,
    operationalCopy: {
      nativeTablesVerified: 102,
      nativeTableContentSha256: "d".repeat(64),
      migrations: getReleaseMigrationLedger(),
      replica: {
        calendarLines: 787,
        reannouncedCalendarLines: 787,
        serviceIndicatorsVerified: 298,
        serviceColorsVerified: 166,
        reannouncedServiceColors: 166,
      },
      application: {
        ownerSignedIn: true,
        calendarLines: 26,
        serviceLines: 27,
        staffColumns: 7,
        anonymousCalendarDenied: true,
        customerCalendarDenied: true,
        customerBookingPaused: true,
        ...(move ? { move } : {}),
      },
      privateArchiveExcluded: true,
      originalArchiveUnchanged: true,
      onlineBookingPaused: true,
      credentialAndDeliveryTablesEmptyBeforeRehearsal: true,
    },
  };
}

test("an operational write receipt verifies the archived day and live synchronization in both directions", () => {
  const receipt = operationalReceipt(operationalWrite);
  expect(
    verifyPortableBooksyRehearsal(receipt, operationalReference, "operational-write"),
  ).toMatchObject({
    recoveryEvidenceVerified: true,
    rehearsal: "operational-write",
    calendarLines: 787,
    dayCalendarLines: 26,
    canCutOver: false,
  });
  for (const reference of [
    { ...operationalReference, date: "2026-11-19" },
    { ...operationalReference, snapshotHash: ciphertext },
    { ...operationalReference, encryptedSha256: snapshot },
  ]) {
    expect(() => verifyPortableBooksyRehearsal(receipt, reference, "operational-write")).toThrow(
      "selected snapshot, encrypted backup or rehearsal day",
    );
  }
  expect(() =>
    verifyPortableBooksyRehearsal(
      {
        ...receipt,
        operationalCopy: {
          ...receipt.operationalCopy,
          migrations: { ...receipt.operationalCopy.migrations, ledgerSha256: snapshot },
        },
      },
      operationalReference,
      "operational-write",
    ),
  ).toThrow("different migration ledger");
});

test("the operational verifier requires preservation, permission and replica evidence", () => {
  const receipt = operationalReceipt(operationalWrite);
  const { operationalCopy } = receipt;
  for (const partial of [
    { ...receipt, canCutOver: true },
    { ...receipt, day: { ...receipt.day, calendarLines: 25 } },
    { ...receipt, candidate: { ...receipt.candidate, staff: 6 } },
    ...[
      { ...operationalCopy, privateArchiveExcluded: false },
      { ...operationalCopy, originalArchiveUnchanged: false },
      { ...operationalCopy, onlineBookingPaused: false },
      { ...operationalCopy, credentialAndDeliveryTablesEmptyBeforeRehearsal: false },
      { ...operationalCopy, replica: { ...operationalCopy.replica, calendarLines: 786 } },
      {
        ...operationalCopy,
        application: { ...operationalCopy.application, customerCalendarDenied: false },
      },
    ].map((operationalCopy) => ({ ...receipt, operationalCopy })),
  ]) {
    expect(() =>
      verifyPortableBooksyRehearsal(partial, operationalReference, "operational-write"),
    ).toThrow("successful migrated rehearsal");
  }
  for (const flag of Object.keys(operationalWrite)) {
    const partial = { ...operationalWrite, [flag]: undefined };
    expect(() =>
      verifyPortableBooksyRehearsal(
        operationalReceipt(partial),
        operationalReference,
        "operational-write",
      ),
    ).toThrow("successful migrated rehearsal");
  }
});

test("the operator explicitly selects the copy, write or scheduling evidence", () => {
  const copy = operationalReceipt();
  const write = operationalReceipt(operationalWrite);
  expect(
    verifyPortableBooksyRehearsal(copy, operationalReference, "operational-copy"),
  ).toMatchObject({
    recoveryEvidenceVerified: true,
    rehearsal: "operational-copy",
    canCutOver: false,
  });
  expect(() =>
    verifyPortableBooksyRehearsal(copy, operationalReference, "operational-write"),
  ).toThrow("successful migrated rehearsal");
  expect(() =>
    verifyPortableBooksyRehearsal(write, operationalReference, "operational-copy"),
  ).toThrow("successful migrated rehearsal");
  expect(() => verifyPortableBooksyRehearsal(write, operationalReference)).toThrow(
    "successful migrated rehearsal",
  );
});
