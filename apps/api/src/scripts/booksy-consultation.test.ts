import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

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
