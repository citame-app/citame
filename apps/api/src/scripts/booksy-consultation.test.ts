import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBooksyLocalOwner } from "./booksy-consultation";

const script = fileURLToPath(
  new URL("./booksy-consultation.ts", import.meta.url),
);

test("prepared startup and its check are restricted to the isolated desktop copy", () => {
  const launch = (mode: string, ...flags: string[]) =>
    Bun.spawnSync({
      cmd: [process.execPath, script, ".", "snapshot", mode, ...flags],
      env: {
        ...process.env,
        BOOKSY_REHEARSAL_DATABASE_URL: "",
        VALKEY_URL: "",
      },
    });
  for (const flag of ["--prepared", "--check-prepared"]) {
    const desktop = launch("--desktop-test", flag);
    expect(desktop.exitCode).toBe(1);
    expect(desktop.stderr.toString()).toContain("Expected private directory");
    const archive = launch("archive", flag);
    expect(archive.exitCode).toBe(1);
    expect(archive.stderr.toString()).toContain(
      "Unexpected consultation arguments",
    );
  }
  expect(
    launch(
      "--desktop-test",
      "--prepared",
      "--check-prepared",
    ).stderr.toString(),
  ).toContain("Unexpected consultation arguments");
});

test("local owner credentials require a private file and hide invalid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-test-owner-"));
  const file = join(directory, "local-owner.json");
  try {
    await writeFile(file, '{"password":DO_NOT_PRINT_THIS}', { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(readBooksyLocalOwner(file)).rejects.toThrow("Expected an operator-owned private file");
    await chmod(file, 0o600);
    await expect(readBooksyLocalOwner(file)).rejects.toThrow(/^Invalid local owner credentials$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
