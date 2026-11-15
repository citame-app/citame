import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRelease, releaseNotes } from "./release";

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
  ) as { jobs: Record<string, Job> };
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
  for (const job of ["desktop-linux", "images", "release"]) {
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
  }
  expect(workflow.jobs["desktop-linux"]?.["continue-on-error"]).not.toBe(true);
  expect(
    workflow.jobs["desktop-linux"]?.steps?.some((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ),
  ).toBe(true);
});
