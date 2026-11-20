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
  const run = (mask: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        'umask "$1"; shift; exec bash scripts/package-desktop.sh "$@"',
        "package-test",
        mask,
        binary,
        output,
      ],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          GITHUB_OUTPUT: "",
          RELEASE_TAG: "v0.1.0",
          RELEASE_OUTPUT_DIR: join(dir, "metadata"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  try {
    const first = run("022");
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const archive = readdirSync(output).find((name) => name.endsWith(".tar.gz"));
    if (!archive) throw new Error("archive missing");
    const contents = Bun.spawnSync(["tar", "tzf", join(output, archive)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contents.exitCode).toBe(0);
    for (const file of ["sob-desktop", "README.md", "LICENSE", "install.sh", "icon.svg"])
      expect(contents.stdout.toString()).toContain(`/${file}\n`);
    const bytes = readFileSync(join(output, archive));
    const checksum = Bun.spawnSync(["sha256sum", "-c", `${archive}.sha256`], {
      cwd: output,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(checksum.exitCode, checksum.stderr.toString()).toBe(0);
    const extracted = Bun.spawnSync(["tar", "xzf", join(output, archive), "-C", dir]);
    expect(extracted.exitCode).toBe(0);
    const packageDir = join(dir, archive.slice(0, -".tar.gz".length));
    const appData = join(dir, "user data");
    const install = () =>
      Bun.spawnSync(["bash", join(packageDir, "install.sh")], {
        env: { ...process.env, XDG_DATA_HOME: appData },
        stdout: "pipe",
        stderr: "pipe",
      });
    const installed = install();
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    const config = join(appData, "sisters-of-beauty", "desktop", "api-url");
    await Bun.write(config, "https://citame.example\n");
    expect(install().exitCode).toBe(0);
    expect(await Bun.file(config).text()).toBe("https://citame.example\n");
    const desktopEntry = await Bun.file(
      join(appData, "applications", "app.citame.desktop.desktop"),
    ).text();
    expect(desktopEntry).toContain(`Exec=/usr/bin/env -- "${appData}/citame/bin/sob-desktop"`);
    expect(Bun.spawnSync([join(appData, "citame", "bin", "sob-desktop")]).exitCode).toBe(0);
    const tabData = join(dir, "user\tdata");
    const installWithTab = Bun.spawnSync(["bash", join(packageDir, "install.sh")], {
      env: { ...process.env, XDG_DATA_HOME: tabData },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installWithTab.exitCode, installWithTab.stderr.toString()).toBe(0);
    const tabEntry = await Bun.file(
      join(tabData, "applications", "app.citame.desktop.desktop"),
    ).text();
    expect(tabEntry).toContain('user\\tdata/citame/bin/sob-desktop"');
    expect(tabEntry).not.toContain("\t");
    const second = run("077");
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

test("macOS packaging verifies the extracted revision, startup and notarization before emitting a ZIP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "citame-macos-package-"));
  const binary = join(dir, "sob-desktop");
  const key = join(dir, "notary.p8");
  const events = join(dir, "events");
  const commands = {
    uname: 'if [ "$1" = -s ]; then echo Darwin; else echo "$MACOS_TEST_ARCH"; fi',
    lipo: 'echo "$MACOS_TEST_ARCH"',
    sleep: 'if [ "$MACOS_GUI_RESULT" = timeout ]; then exit 0; fi; exec /bin/sleep "$@"',
    plutil: `case "$1:$2" in
      -lint:*) test -f "$2" ;;
      -extract:CFBundleIdentifier) echo app.citame.desktop ;;
      -extract:CFBundleExecutable) echo sob-desktop ;;
      -extract:LSMinimumSystemVersion) echo 15.0 ;;
      -extract:CFBundleShortVersionString) echo 0.1.0 ;;
      *) exit 1 ;;
    esac`,
    sips: 'touch "$6"',
    iconutil: 'printf "mock icon" > "$5"',
    codesign: 'printf "codesign %s\n" "$*" >> "$NOTARY_LOG"',
    ditto: `case "$1" in
      -c)
        printf "archive\n" >> "$NOTARY_LOG"
        cp -R "$4" "$5.bundle" || exit 1
        printf "mock" > "$5" ;;
      -x)
        printf "extract\n" >> "$NOTARY_LOG"
        cp -R "$3.bundle" "$4/Citame.app" || exit 1
        if [ -n "$EXTRACTED_METADATA" ]; then
          cp "$EXTRACTED_METADATA" "$4/Citame.app/Contents/Resources/metadata.json"
        fi ;;
      *) exit 1 ;;
    esac`,
    xcrun: `printf "%s %s\n" "$1" "$2" >> "$NOTARY_LOG"
case "$1" in
  notarytool) printf '{"status":"%s","id":"sample"}\n' "$NOTARY_STATUS" ;;
  vtool) printf '    minos %s\n' "$MACOS_BINARY_MINIMUM" ;;
  stapler)
    if [ "$2" = validate ] && [ "$FINAL_TICKET" = invalid ] &&
        grep -qx extract "$NOTARY_LOG"; then
      echo "Missing notarization ticket in distributed ZIP" >&2
      exit 8
    fi ;;
esac`,
    spctl: 'printf "gatekeeper\n" >> "$NOTARY_LOG"',
  };
  try {
    for (const [name, contents] of Object.entries(commands)) {
      const path = join(dir, name);
      await Bun.write(path, `#!/bin/sh\n${contents}\n`);
      chmodSync(path, 0o755);
    }
    await Bun.write(
      binary,
      `#!/bin/sh
if [ "$1" = --check-installation ]; then
  printf 'Citame 0.1.0 SQLite ready\n'
  exit 0
fi
test "$SOB_API_URL" = http://127.0.0.1:1 && test -n "$SOB_DATA_DIR" && test "$SOB_STARTUP_TIMINGS" = 1 || exit 2
if [ "$MACOS_GUI_RESULT" = failure ]; then exit 3; fi
if [ "$MACOS_GUI_RESULT" != timeout ]; then printf 'citame startup first frame callback: 24 ms\n'; fi
exec /bin/sleep 30
`,
    );
    chmodSync(binary, 0o755);
    await Bun.write(key, "test-only key");
    const output = join(dir, "output");
    const adHocOutput = join(dir, "ad-hoc");
    const run = (
      status: string,
      identity: string,
      minimum = "15.0",
      ticket = "valid",
      env: Record<string, string> = {},
      destination = output,
    ) =>
      Bun.spawnSync(["bash", "scripts/package-desktop-macos.sh", binary, destination], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_ACTIONS: "false",
          GITHUB_OUTPUT: "",
          RELEASE_TAG: "v0.1.0",
          RELEASE_OUTPUT_DIR: join(dir, "metadata"),
          CITAME_MAC_REQUIRE_NOTARY: "1",
          CITAME_MAC_SIGN_IDENTITY: identity,
          CITAME_NOTARY_KEY: key,
          CITAME_NOTARY_KEY_ID: "TEST_KEY",
          CITAME_NOTARY_ISSUER: "issuer",
          NOTARY_LOG: events,
          NOTARY_STATUS: status,
          MACOS_BINARY_MINIMUM: minimum,
          FINAL_TICKET: ticket,
          RELEASE_REVISION: "",
          CITAME_MAC_VERIFY_GUI: "0",
          EXTRACTED_METADATA: "",
          MACOS_TEST_ARCH: "arm64",
          MACOS_GUI_RESULT: "",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const unsigned = run("Accepted", "");
    expect(unsigned.exitCode).not.toBe(0);
    expect(unsigned.stderr.toString()).toContain("Developer ID Application identity");
    const rejected = run("Invalid", "Developer ID Application: Citame");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("Notarization sample: Invalid");
    expect(readdirSync(output)).toEqual([]);
    expect(await Bun.file(events).text()).not.toContain("stapler staple");
    const incompatible = run("Accepted", "Developer ID Application: Citame", "15.1");
    expect(incompatible.exitCode).not.toBe(0);
    expect(incompatible.stderr.toString()).toContain("Invalid executable minimum");
    expect(readdirSync(output)).toEqual([]);
    await Bun.write(events, "");
    const missingTicket = run("Accepted", "Developer ID Application: Citame", "15.0", "invalid");
    expect(missingTicket.exitCode).toBe(8);
    expect(missingTicket.stderr.toString()).toContain("Missing notarization ticket");
    expect(readdirSync(output)).toEqual([]);

    const revision = "a".repeat(40);
    const metadata = join(dir, "extracted-metadata.json");
    const adHocVerification = {
      CITAME_MAC_REQUIRE_NOTARY: "0",
      CITAME_MAC_VERIFY_GUI: "1",
      RELEASE_REVISION: revision,
      EXTRACTED_METADATA: metadata,
    };
    await Bun.write(
      metadata,
      JSON.stringify({ tag: "v0.1.0", version: "0.1.0", revision: "b".repeat(40), dirty: false }),
    );
    const wrongRevision = run("Accepted", "", "15.0", "valid", adHocVerification);
    expect(wrongRevision.exitCode).not.toBe(0);
    expect(wrongRevision.stderr.toString()).toContain(
      "metadata does not match the clean, verified revision",
    );
    expect(readdirSync(output)).toEqual([]);

    await Bun.write(
      metadata,
      JSON.stringify({ tag: "v0.1.0", version: "0.1.0", revision, dirty: false }),
    );
    const noWindow = run("Accepted", "", "15.0", "valid", {
      ...adHocVerification,
      MACOS_GUI_RESULT: "failure",
    });
    expect(noWindow.exitCode).not.toBe(0);
    expect(noWindow.stderr.toString()).toContain("did not open its first window");
    expect(readdirSync(output)).toEqual([]);
    const timedOut = run("Accepted", "", "15.0", "valid", {
      ...adHocVerification,
      MACOS_GUI_RESULT: "timeout",
    });
    expect(timedOut.exitCode).not.toBe(0);
    expect(timedOut.stderr.toString()).toContain("did not open its first window");
    expect(readdirSync(output)).toEqual([]);
    const window = run("Accepted", "", "15.0", "valid", adHocVerification, adHocOutput);
    expect(window.exitCode, window.stderr.toString()).toBe(0);
    expect(window.stdout.toString()).toContain("citame startup first frame callback: 24 ms");

    const intel = run(
      "Accepted",
      "",
      "15.0",
      "valid",
      { ...adHocVerification, CITAME_MAC_VERIFY_GUI: "0", MACOS_TEST_ARCH: "x86_64" },
      adHocOutput,
    );
    expect(intel.exitCode, intel.stderr.toString()).toBe(0);
    expect(intel.stdout.toString()).toContain("ZIP verified on x86_64");
    expect(readdirSync(adHocOutput).sort()).toEqual([
      "sisters-of-beauty-desktop-0.1.0-macos-arm64.zip",
      "sisters-of-beauty-desktop-0.1.0-macos-arm64.zip.sha256",
      "sisters-of-beauty-desktop-0.1.0-macos-x86_64.zip",
      "sisters-of-beauty-desktop-0.1.0-macos-x86_64.zip.sha256",
    ]);
    expect(readdirSync(output)).toEqual([]);
    await Bun.write(events, "");
    const accepted = run("Accepted", "Developer ID Application: Citame", "15.0", "valid", {
      RELEASE_REVISION: revision,
      EXTRACTED_METADATA: metadata,
    });
    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
    expect(await Bun.file(events).text()).toContain("--options runtime --timestamp");
    expect(await Bun.file(events).text()).toContain(
      "archive\nnotarytool submit\nstapler staple\nstapler validate\ngatekeeper\narchive\n",
    );
    expect(await Bun.file(events).text()).toContain("archive\nextract\nvtool -show-build\n");
    expect(readdirSync(output).sort()).toEqual([
      "sisters-of-beauty-desktop-0.1.0-macos-arm64.zip",
      "sisters-of-beauty-desktop-0.1.0-macos-arm64.zip.sha256",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
