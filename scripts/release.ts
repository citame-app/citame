import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const manifests = [
  "package.json",
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/db/package.json",
  "packages/contracts/package.json",
  "packages/config/package.json",
];

export function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[([^\]]+)\]/.exec(line)?.[1] === version);
  if (start < 0) throw new Error(`CHANGELOG.md has no [${version}] section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line));
  const notes = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md has an empty [${version}] section`);
  return notes;
}

export function verifyReleaseTag(root: string, tag: string, revision: string): void {
  if (!/^v[\dA-Za-z.-]+$/.test(tag) || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid release tag or revision");
  const ref = `refs/tags/${tag}`;
  const remote = Bun.spawnSync(
    ["git", "ls-remote", "--exit-code", "--tags", "origin", ref, `${ref}^{}`],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (remote.exitCode !== 0) throw new Error(`Cannot verify ${ref} on origin`);
  const refs = new Map(
    remote.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [sha, name] = line.split("\t");
        return [name, sha];
      }),
  );
  if ((refs.get(`${ref}^{}`) ?? refs.get(ref)) !== revision)
    throw new Error(`${ref} no longer points to the verified revision ${revision}`);
}

export async function checkRelease(root: string, tag: string, repository?: string) {
  const match =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag,
    );
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    throw new Error(
      "Release tag must be canonical vMAJOR.MINOR.PATCH[-prerelease], without build metadata",
    );
  const version = tag.slice(1);
  let imagePrefix: string | null = null;
  if (repository !== undefined) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository === "OWNER/REPO" ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Invalid or placeholder repository path");
    imagePrefix = `ghcr.io/${repository.toLowerCase()}`;
  }
  for (const file of manifests) {
    const pkg = JSON.parse(await readFile(join(root, file), "utf8"));
    if (pkg.version !== version)
      throw new Error(`${file} is ${pkg.version}, tag requires ${version}`);
  }
  const cargo = await readFile(join(root, "apps/desktop/Cargo.toml"), "utf8");
  const workspace = cargo.split(/^\[workspace\.package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(workspace ?? "")?.[1];
  if (cargoVersion !== version)
    throw new Error(`Cargo.toml workspace is ${cargoVersion}, tag requires ${version}`);
  return {
    tag,
    version,
    prerelease: Boolean(match[4]),
    imagePrefix,
    notes: releaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), version),
  };
}

async function cli() {
  const command = process.argv[2] ?? "validate";
  if (
    command !== "validate" &&
    command !== "validate-source" &&
    command !== "notes" &&
    command !== "verify-tag" &&
    command !== "verify-metadata"
  )
    throw new Error(
      "Usage: bun scripts/release.ts validate|validate-source|notes|verify-tag|verify-metadata [vMAJOR.MINOR.PATCH]",
    );
  const root = process.cwd();
  const tag =
    process.env.RELEASE_TAG ??
    process.argv[3] ??
    `v${JSON.parse(await readFile(join(root, "package.json"), "utf8")).version}`;
  const repository = process.env.GITHUB_REPOSITORY;
  const publishing = process.env.RELEASE_PUBLISHING === "1";
  if (command === "verify-metadata") {
    const metadata = await Bun.stdin.json();
    if (
      !/^[a-f0-9]{40}$/.test(process.env.RELEASE_REVISION ?? "") ||
      metadata.revision !== process.env.RELEASE_REVISION ||
      metadata.tag !== tag ||
      metadata.version !== tag.slice(1) ||
      metadata.dirty !== false
    )
      throw new Error("Desktop archive metadata does not match the clean, verified revision");
    return;
  }
  if (command === "verify-tag") {
    verifyReleaseTag(root, tag, process.env.RELEASE_REVISION ?? "");
    return;
  }
  if (process.env.GITHUB_ACTIONS === "true" && (!process.env.RELEASE_TAG || !repository))
    throw new Error("GitHub release jobs require RELEASE_TAG and GITHUB_REPOSITORY");
  const info = await checkRelease(root, tag, repository);
  const dir = resolve(root, process.env.RELEASE_OUTPUT_DIR ?? ".release");
  await mkdir(dir, { recursive: true });
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (revision.exitCode !== 0) throw new Error("Release preparation requires a Git checkout");
  const sha = revision.stdout.toString().trim();
  if (publishing) {
    if (process.env.GITHUB_REF !== `refs/tags/${tag}` || process.env.GITHUB_SHA !== sha)
      throw new Error(`Run the release from ${tag} at the exact checkout revision`);
    verifyReleaseTag(root, tag, sha);
  }
  if (command === "validate-source") {
    const ancestry = Bun.spawnSync(
      ["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (ancestry.exitCode !== 0)
      throw new Error("Release revision must be reachable from origin/main");
  }
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (status.exitCode !== 0) throw new Error("Could not inspect release checkout");
  const dirty = status.stdout.toString().trim().length > 0;
  if (dirty && (publishing || process.env.GITHUB_ACTIONS === "true"))
    throw new Error("Release jobs require a clean Git checkout");
  await writeFile(
    join(dir, "metadata.json"),
    `${JSON.stringify({ ...info, revision: sha, dirty }, null, 2)}\n`,
  );
  let images = "";
  if (info.imagePrefix) {
    const references = await Promise.all(
      ["api", "web"].map(async (kind) => {
        const name = `${info.imagePrefix}-${kind}`;
        if (command !== "notes" || !publishing) return `${name}:${info.version}`;
        const digest = (await readFile(join(dir, "images", `${kind}.digest`), "utf8")).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(digest))
          throw new Error(`Invalid verified ${kind} image digest`);
        return `${name}@${digest}`;
      }),
    );
    images = `\n\nImages (linux/amd64, linux/arm64) for commit \`${sha}\`:\n${references.map((ref) => `- \`${ref}\``).join("\n")}`;
  }
  await writeFile(join(dir, "notes.md"), `${info.notes}${images}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tag=${info.tag}\nversion=${info.version}\nimage_prefix=${info.imagePrefix ?? ""}\nprerelease=${info.prerelease}\nrevision=${sha}\n`,
    );
  }
  console.log(
    JSON.stringify({
      tag: info.tag,
      version: info.version,
      prerelease: info.prerelease,
      imagePrefix: info.imagePrefix,
      output: dir,
    }),
  );
}

if (import.meta.main) {
  try {
    await cli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release validation failed");
    process.exitCode = 1;
  }
}
