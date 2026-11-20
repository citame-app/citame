import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRelease, releaseNotes, verifyReleaseTag } from "./release";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "sob-release-"));
  dirs.push(root);
  const write = (file: string, value: string) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  for (const file of [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/db/package.json",
    "packages/contracts/package.json",
    "packages/config/package.json",
  ])
    write(file, JSON.stringify({ version }));
  write(
    "apps/desktop/Cargo.toml",
    `[workspace]\nresolver = "3"\n[workspace.package]\nversion = "${version}"\n`,
  );
  write(
    "CHANGELOG.md",
    `# Changelog\n\n## [Unreleased]\n\nDo not release this.\n\n## [${version}] - 2026-11-15\n\nVerified release notes.\n\n## [0.0.1]\n\nOld notes.\n`,
  );
  return { root, write };
}

test("release preparation works offline without inventing a repository", async () => {
  const { root } = fixture();
  expect(await checkRelease(root, "v0.1.0")).toEqual({
    tag: "v0.1.0",
    version: "0.1.0",
    prerelease: false,
    imagePrefix: null,
    notes: "Verified release notes.",
  });
});

test("registry image paths are normalized, and prereleases remain prereleases", async () => {
  const { root } = fixture("0.1.0-rc.1");
  expect(await checkRelease(root, "v0.1.0-rc.1", "Example/Salon")).toMatchObject({
    imagePrefix: "ghcr.io/example/salon",
    prerelease: true,
  });
});

for (const tag of [
  "main",
  "v01.0.0",
  "v0.1",
  "v1.0.0-01",
  "v1.0.0+build",
  "v0.1.0\nunsafe=1",
  "v$(touch /tmp/unsafe)",
]) {
  test(`rejects invalid or unsafe release tag ${JSON.stringify(tag)}`, async () => {
    await expect(checkRelease(fixture().root, tag)).rejects.toThrow("tag");
  });
}

test("every package and the Cargo workspace must agree with the tag", async () => {
  const { root, write } = fixture();
  write("apps/api/package.json", JSON.stringify({ version: "0.2.0" }));
  await expect(checkRelease(root, "v0.1.0")).rejects.toThrow("apps/api/package.json");
  write("apps/api/package.json", JSON.stringify({ version: "0.1.0" }));
  write("apps/desktop/Cargo.toml", '[workspace.package]\nversion = "0.2.0"\n');
  await expect(checkRelease(root, "v0.1.0")).rejects.toThrow("Cargo.toml");
});

test("missing and empty changelog sections cannot produce a release", async () => {
  const { root, write } = fixture();
  write("CHANGELOG.md", "## [0.2.0]\nOther release.\n");
  await expect(checkRelease(root, "v0.1.0")).rejects.toThrow("CHANGELOG");
  write("CHANGELOG.md", "## [0.1.0]\n\n## [0.0.1]\nOld.\n");
  await expect(checkRelease(root, "v0.1.0")).rejects.toThrow("empty");
});

test("notes extraction treats version dots literally", () => {
  expect(releaseNotes("## [0x1x0]\nWrong.\n## [0.1.0]\nCorrect.\n## [0.0.1]\nOld.", "0.1.0")).toBe(
    "Correct.",
  );
});

test("unsafe or placeholder repository paths cannot become image names", async () => {
  for (const repo of ["OWNER/REPO", "owner/repo\noutput=bad", "../repo", "owner/repo/path"]) {
    await expect(checkRelease(fixture().root, "v0.1.0", repo)).rejects.toThrow("repository");
  }
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function commit(root: string, message: string) {
  git(
    root,
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.com",
    "commit",
    "--no-gpg-sign",
    "--allow-empty",
    "-qm",
    message,
  );
  return git(root, "rev-parse", "HEAD");
}

test("verifies lightweight and annotated origin tags and blocks moved or missing tags", () => {
  const { root } = fixture();
  git(root, "init", "-q");
  git(root, "add", ".");
  const checked = commit(root, "checked");
  git(root, "remote", "add", "origin", root);
  git(root, "tag", "v0.1.0", checked);
  git(
    root,
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.com",
    "tag",
    "-am",
    "annotated",
    "v0.1.1",
    checked,
  );
  verifyReleaseTag(root, "v0.1.0", checked);
  verifyReleaseTag(root, "v0.1.1", checked);
  const moved = commit(root, "moved");
  git(root, "tag", "-f", "v0.1.0", moved);
  expect(() => verifyReleaseTag(root, "v0.1.0", checked)).toThrow("no longer points");
  expect(() => verifyReleaseTag(root, "v0.1.2", checked)).toThrow("Cannot verify");
});

test("publishing rejects a branch dispatch and uses only verified image references in notes", async () => {
  const { root, write } = fixture();
  write(".gitignore", ".release/\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  const revision = commit(root, "publishable");
  git(root, "remote", "add", "origin", root);
  git(root, "tag", "v0.1.0", revision);
  const call = (ref: string, command: string) =>
    Bun.spawnSync(["bun", join(import.meta.dirname, "release.ts"), command], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "Test/Repo",
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: revision,
        GITHUB_REF: ref,
        RELEASE_TAG: "v0.1.0",
        RELEASE_PUBLISHING: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  expect(call("refs/heads/main", "validate").stderr.toString()).toContain(
    "Run the release from v0.1.0",
  );
  expect(call("refs/tags/v0.1.0", "validate-source").stderr.toString()).toContain("origin/main");
  git(root, "update-ref", "refs/remotes/origin/main", revision);
  expect(call("refs/tags/v0.1.0", "validate-source").exitCode).toBe(0);
  expect(call("refs/tags/v0.1.0", "notes").exitCode).toBe(1);
  write(".release/images/api.digest", `sha256:${"a".repeat(64)}\n`);
  write(".release/images/web.digest", `sha256:${"b".repeat(64)}\n`);
  const notes = call("refs/tags/v0.1.0", "notes");
  expect(notes.exitCode, notes.stderr.toString()).toBe(0);
  const output = readFileSync(join(root, ".release/notes.md"), "utf8");
  expect(output).toContain(`ghcr.io/test/repo-api@sha256:${"a".repeat(64)}`);
  expect(output).toContain(`ghcr.io/test/repo-web@sha256:${"b".repeat(64)}`);
  expect(output).toContain(revision);
  expect(output).not.toContain("repo-api:0.1.0");
});

test("offline metadata records a dirty worktree instead of attributing it to HEAD", async () => {
  const { root, write } = fixture();
  write(".gitignore", ".release/\n");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.com",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  );
  write("uncommitted.txt", "pending change");
  const child = Bun.spawn(["bun", join(import.meta.dirname, "release.ts"), "validate"], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_ACTIONS: "false",
      GITHUB_REPOSITORY: "Test/Repo",
      GITHUB_OUTPUT: join(root, ".release/github-output"),
      RELEASE_TAG: "v0.1.0",
      RELEASE_OUTPUT_DIR: ".release",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit, errors).toBe(0);
  const metadata = JSON.parse(readFileSync(join(root, ".release/metadata.json"), "utf8"));
  expect(metadata.dirty).toBe(true);
  expect(readFileSync(join(root, ".release/github-output"), "utf8")).toContain(
    `revision=${metadata.revision}\n`,
  );
});

test("publication requires CI and a successful desktop artifact build", () => {
  type Job = {
    with?: Record<string, string>;
    needs?: string | string[];
    uses?: string;
    "continue-on-error"?: boolean;
    outputs?: Record<string, string>;
    steps?: { uses?: string; with?: Record<string, string> }[];
  };
  const root = join(import.meta.dirname, "..");
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
  ) as { jobs: Record<string, Job>; concurrency: { group: string; "cancel-in-progress": boolean } };
  const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    on: Record<string, unknown>;
  };
  const ancestors = (job: string, seen = new Set<string>()) => {
    const needs = workflow.jobs[job]?.needs ?? [];
    for (const name of typeof needs === "string" ? [needs] : needs) {
      if (!seen.has(name)) {
        seen.add(name);
        ancestors(name, seen);
      }
    }
    return [...seen];
  };
  expect(workflow.jobs.checks?.uses).toBe("./.github/workflows/ci.yml");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
  expect(workflow.jobs.checks?.with?.ref).toBe("${{ needs.meta.outputs.revision }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
  expect(workflow.jobs.meta?.outputs?.revision).toBe("${{ steps.v.outputs.revision }}");
  expect(workflow.concurrency).toEqual({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
    group: "release-${{ github.event.inputs.tag || github.ref_name }}",
    "cancel-in-progress": false,
  });
  for (const job of ["desktop-linux", "desktop-macos", "images", "release"]) {
    const checkout = workflow.jobs[job]?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
    expect(checkout?.with?.ref).toBe("${{ needs.meta.outputs.revision }}");
  }
  expect(Object.hasOwn(ci.on, "workflow_call")).toBe(true);
  for (const job of ["images", "release"]) {
    expect(ancestors(job)).toContain("checks");
    expect(ancestors(job)).toContain("desktop-linux");
    expect(ancestors(job)).toContain("desktop-macos");
  }
  expect(workflow.jobs["desktop-linux"]?.["continue-on-error"]).not.toBe(true);
  expect(
    workflow.jobs["desktop-linux"]?.steps?.some((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ),
  ).toBe(true);
});

const packageRevision = "c".repeat(40);

function packageFixture(root: string, target: string, revision: string, payload: string) {
  mkdirSync(target, { recursive: true });
  const prefix = "sisters-of-beauty-desktop-0.1.0";
  const linux = `${prefix}-linux-x86_64`;
  const darwin = "Citame.app/Contents/Resources";
  for (const directory of [linux, darwin]) mkdirSync(join(root, directory), { recursive: true });
  const metadata = JSON.stringify({ revision, tag: "v0.1.0", version: "0.1.0", dirty: false });
  writeFileSync(join(root, linux, "release.json"), metadata);
  writeFileSync(join(root, darwin, "metadata.json"), metadata);
  writeFileSync(join(root, darwin, "fixture.txt"), payload);
  const build = (...args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: root, stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  build("tar", "-czf", join(target, `${linux}.tar.gz`), linux);
  for (const arch of ["arm64", "x86_64"]) {
    build("zip", "-qr", join(target, `${prefix}-macos-${arch}.zip`), "Citame.app");
  }
  for (const name of [
    `${linux}.tar.gz`,
    `${prefix}-macos-arm64.zip`,
    `${prefix}-macos-x86_64.zip`,
  ]) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(target, name)))
      .digest("hex");
    writeFileSync(join(target, `${name}.sha256`), `${hash}  ${name}\n`);
  }
}

test.each([
  {
    existing: "missing",
    upload: "ok",
    expected: 0,
    calls: "tag view create upload view download image image tag edit",
  },
  { existing: "true", upload: "fail", expected: 9, calls: "tag view upload" },
  { existing: "true", upload: "incomplete", expected: 1, calls: "tag view upload view" },
  { existing: "true", upload: "stale", expected: 1, calls: "tag view upload view download" },
  { existing: "true", upload: "bad-signature", expected: 5, calls: "tag view" },
  {
    existing: "false",
    upload: "ok",
    expected: 0,
    calls: "tag view view download image image view",
  },
  { existing: "false", upload: "stale", expected: 1, calls: "tag view view download" },
  {
    existing: "false",
    upload: "archived",
    expected: 0,
    calls: "tag view view download image image view",
  },
  { existing: "false", upload: "wrong-revision", expected: 1, calls: "tag view view download" },
  {
    existing: "false",
    upload: "wrong-notes",
    expected: 1,
    calls: "tag view view download image image view",
  },
  {
    existing: "true",
    upload: "wrong-image",
    expected: 6,
    calls: "tag view upload view download image",
  },
  {
    existing: "true",
    upload: "retagged",
    expected: 8,
    calls: "tag view upload view download image image tag",
  },
])("publishes only after all desktop assets are uploaded ($existing, $upload)", (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "sob-release-publication-"));
  dirs.push(root);
  const desktop = join(root, ".release/desktop");
  packageFixture(root, desktop, packageRevision, "fresh notarization");
  if (["archived", "wrong-revision"].includes(scenario.upload)) {
    packageFixture(
      root,
      join(root, "published"),
      scenario.upload === "archived" ? packageRevision : "d".repeat(40),
      "original notarization",
    );
    const name = "sisters-of-beauty-desktop-0.1.0-macos-arm64.zip.sha256";
    expect(readFileSync(join(root, "published", name), "utf8")).not.toBe(
      readFileSync(join(desktop, name), "utf8"),
    );
  }
  mkdirSync(join(root, ".release/images"));
  writeFileSync(join(root, ".release/images/api.digest"), `sha256:${"a".repeat(64)}\n`);
  writeFileSync(join(root, ".release/images/web.digest"), `sha256:${"b".repeat(64)}\n`);
  writeFileSync(
    join(root, "bun"),
    [
      "#!/usr/bin/env bash",
      'if [ "$*" = "scripts/release.ts verify-metadata" ]; then exec "$REAL_BUN" "$RELEASE_SCRIPT" verify-metadata; fi',
      'if [ "$*" = "scripts/release-registry.ts verify" ]; then echo image >> calls.log; if [ "$UPLOAD" = wrong-image ]; then exit 6; fi; exit 0; fi',
      'test "$*" = "scripts/release.ts verify-tag" || exit 7',
      'if [ "$UPLOAD" = retagged ] && [ -s calls.log ]; then echo tag >> calls.log; exit 8; fi',
      "echo tag >> calls.log",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = attestation ]; then',
      '  [[ " $* " == *" --source-digest $RELEASE_REVISION "* && " $* " == *" --source-ref refs/tags/$TAG "* ]] || exit 7',
      '  if [ "$UPLOAD" = bad-signature ]; then exit 5; fi',
      "  exit 0",
      "fi",
      'echo "$2" >> calls.log',
      'case "$2" in',
      "  view)",
      '    if [ "$5" = isDraft ]; then',
      '      [ "$EXISTING" != missing ] || exit 1',
      '      echo "$EXISTING"',
      '    elif [ "$5" = body ]; then',
      '      [ "$UPLOAD" != wrong-notes ] || exit 0',
      '      for kind in api web; do printf -- \'- `%s-%s@%s`\\n\' "$RELEASE_IMAGE_PREFIX" "$kind" "$(cat ".release/images/$kind.digest")"; done',
      "    else",
      "      for file in .release/desktop/*; do",
      '        if [ "$UPLOAD" = incomplete ] && [[ "$file" == *macos-arm64.zip ]]; then continue; fi',
      '        echo "${file##*/}"',
      "      done",
      "    fi ;;",
      '  upload) [ "$UPLOAD" != fail ] || exit 9 ;;',
      '  create) [[ " $* " == *" --draft "* ]] ;;',
      '  edit) [[ " $* " == *" --draft=false "* ]] ;;',
      "  download)",
      '    [ "$4" = --dir ] || exit 9',
      '    output="$5"',
      "    source=.release/desktop",
      "    if [ -d published ]; then source=published; fi",
      "    shift 5",
      '    while [ "$#" -gt 0 ]; do',
      '      [ "$1" = --pattern ] || exit 9',
      '      cp "$source/$2" "$output/$2" || exit 9',
      '      if [ "$UPLOAD" = stale ] && [[ "$2" == *macos-arm64.zip ]]; then',
      '        printf "stale package" > "$output/$2"',
      "      fi",
      "      shift 2",
      "    done ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dirname, "../.github/workflows/release.yml"), "utf8"),
  ) as { jobs: { release: { steps: { name?: string; run?: string }[] } } };
  const step = workflow.jobs.release.steps.find((entry) =>
    entry.name?.startsWith("Publish release"),
  );
  if (!step?.run) throw new Error("Missing release publication command");
  const result = Bun.spawnSync(["bash", "-e", "-c", step.run], {
    cwd: root,
    env: {
      PATH: `${root}:${process.env.PATH}`,
      TAG: "v0.1.0",
      GITHUB_REPOSITORY: "test/repo",
      RELEASE_TAG: "v0.1.0",
      RELEASE_REVISION: packageRevision,
      RELEASE_IMAGE_PREFIX: "ghcr.io/test/repo",
      REAL_BUN: process.execPath,
      RELEASE_SCRIPT: join(import.meta.dirname, "release.ts"),
      VERSION: "0.1.0",
      PRERELEASE: "false",
      EXISTING: scenario.existing,
      UPLOAD: scenario.upload,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(scenario.expected);
  expect(readFileSync(join(root, "calls.log"), "utf8").trim().replaceAll("\n", " ")).toBe(
    scenario.calls,
  );
});
