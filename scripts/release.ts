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

if (import.meta.main) {
  try {
    const command = process.argv[2] ?? "validate";
    if (command !== "validate" && command !== "notes")
      throw new Error("Usage: bun scripts/release.ts validate|notes [vMAJOR.MINOR.PATCH]");
    const root = process.cwd();
    const tag =
      process.env.RELEASE_TAG ??
      process.argv[3] ??
      `v${JSON.parse(await readFile(join(root, "package.json"), "utf8")).version}`;
    const repository = process.env.GITHUB_REPOSITORY;
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
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (status.exitCode !== 0) throw new Error("Could not inspect release checkout");
    const dirty = status.stdout.toString().trim().length > 0;
    if (dirty && process.env.GITHUB_ACTIONS === "true")
      throw new Error("Release jobs require a clean Git checkout");
    await writeFile(
      join(dir, "metadata.json"),
      `${JSON.stringify({ ...info, revision: revision.stdout.toString().trim(), dirty }, null, 2)}\n`,
    );
    const images = info.imagePrefix
      ? `\n\nImages: \`${info.imagePrefix}-api:${info.version}\` and \`${info.imagePrefix}-web:${info.version}\` (linux/amd64, linux/arm64).`
      : "";
    await writeFile(join(dir, "notes.md"), `${info.notes}${images}\n`);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `tag=${info.tag}\nversion=${info.version}\nimage_prefix=${info.imagePrefix ?? ""}\nprerelease=${info.prerelease}\nrevision=${revision.stdout.toString().trim()}\n`,
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release validation failed");
    process.exitCode = 1;
  }
}
