import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop archives are reproducible, complete and have verifiable checksums", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sob-package-"));
  const binary = join(dir, "binary with spaces");
  const output = join(dir, "output with spaces");
  await Bun.write(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  const run = () =>
    Bun.spawnSync(["bash", "scripts/package-desktop.sh", binary, output], {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_OUTPUT: "",
        RELEASE_TAG: "v0.1.0",
        RELEASE_OUTPUT_DIR: join(dir, "metadata"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    const first = run();
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const archive = readdirSync(output).find((name) => name.endsWith(".tar.gz"));
    if (!archive) throw new Error("archive missing");
    const contents = Bun.spawnSync(["tar", "tzf", join(output, archive)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contents.exitCode).toBe(0);
    for (const file of ["sob-desktop", "README.md", "LICENSE"])
      expect(contents.stdout.toString()).toContain(`/${file}\n`);
    const bytes = readFileSync(join(output, archive));
    const checksum = Bun.spawnSync(["sha256sum", "-c", `${archive}.sha256`], {
      cwd: output,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(checksum.exitCode, checksum.stderr.toString()).toBe(0);
    const second = run();
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(readFileSync(join(output, archive))).toEqual(bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging refuses a missing executable instead of producing an empty release", () => {
  const result = Bun.spawnSync(
    ["bash", "scripts/package-desktop.sh", "/does-not-exist/sob-desktop"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("executable");
});
