import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  restorePortableBooksyBackup,
  sealBooksyBackup,
} from "../apps/api/src/scripts/booksy-portable-backup";
import { privateWrite } from "../apps/api/src/modules/booksy-transfer/vault";

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("seal recovers the original bytes and rejects a tampered package before PostgreSQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-portable-test-"));
  const keyring = join(directory, "keyring");
  const sealedDir = join(directory, "sealed");
  const ring = ["gpg", "--no-options", "--homedir", keyring, "--batch", "--no-tty"];
  const original = Buffer.from("synthetic database bytes\u0000 with accents");
  try {
    await mkdir(keyring, { mode: 0o700 });
    await mkdir(sealedDir, { mode: 0o700 });
    const created = Bun.spawnSync([
      ...ring,
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Citame synthetic recovery",
      "future-default",
      "default",
      "0",
    ]);
    expect(created.exitCode).toBe(0);
    const listing = Bun.spawnSync([...ring, "--with-colons", "--list-keys"]);
    const recipient = listing.stdout
      .toString()
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9];
    if (!recipient) throw new Error("Test key fingerprint missing");

    const dump = join(directory, "candidate-20261117_123.dump");
    const receipt = join(directory, "recovery.json");
    await privateWrite(dump, original);
    await privateWrite(
      receipt,
      JSON.stringify({
        dump,
        sha256: digest(original),
        bytes: original.length,
        database: "sob_booksy_candidate_20261117_123",
        snapshotHash: "a".repeat(64),
        verification: { tables: 94, tableContentSha256: "b".repeat(64) },
        restorationVerified: true,
        canCutOver: false,
      }),
    );

    const result = await sealBooksyBackup(receipt, sealedDir, keyring, recipient);
    expect((await stat(result.archive)).mode & 0o777).toBe(0o600);
    const encrypted = await readFile(result.archive);
    expect(encrypted.includes(original)).toBe(false);
    expect(digest(encrypted)).toBe(result.encryptedSha256);
    const plaintext = Bun.spawnSync([...ring, "--decrypt", result.archive]);
    expect(plaintext.exitCode).toBe(0);
    expect(Buffer.from(plaintext.stdout)).toEqual(original);

    const altered = join(directory, "tampered.gpg");
    encrypted[encrypted.length - 1] ^= 1;
    await privateWrite(altered, encrypted);
    await expect(
      restorePortableBooksyBackup(
        altered,
        result.manifest,
        result.encryptedSha256,
        keyring,
        "2026-11-18",
      ),
    ).rejects.toThrow("SHA-256 differs");
    await expect(
      restorePortableBooksyBackup(
        result.archive,
        result.manifest,
        "f".repeat(64),
        keyring,
        "2026-11-18",
      ),
    ).rejects.toThrow("independently recorded");
  } finally {
    Bun.spawnSync(["gpgconf", "--homedir", keyring, "--kill", "gpg-agent"]);
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
