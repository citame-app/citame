import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BooksyTransfer } from "@sob/contracts";
import { fingerprint } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function readPrivateArchiveFile(file: string) {
  const path = await realpath(file);
  const directory = dirname(path);
  const [folder, info] = await Promise.all([stat(directory), stat(path)]);
  const owner = process.getuid?.();
  if (
    !info.isFile() ||
    folder.uid !== owner ||
    info.uid !== owner ||
    ((folder.mode | info.mode) & 0o077) !== 0
  )
    throw new Error("Expected an operator-owned private file and archive directory");
  return { path, directory, bytes: await readFile(path) };
}

export async function readPrivateBooksySnapshot(file: string) {
  const { path, directory, bytes } = await readPrivateArchiveFile(file);
  const hash = /^source-snapshot-([a-f0-9]{64})\.json$/.exec(basename(path))?.[1];
  const model = JSON.parse(bytes.toString("utf8")) as BooksySourceReadModel;
  if (!hash || fingerprint(model) !== hash) throw new Error("Snapshot hash differs");
  return { hash, model, directory };
}
/** SQL errors may contain every bound client field; keep those out of console/log output. */
export function privateCliError(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === "object" &&
    ("query" in error || (error instanceof Error && /Failed query:/i.test(error.message)))
  )
    return `${fallback}; original files and the isolated copy were retained`;
  return error instanceof Error ? error.message : fallback;
}
export async function privateWrite(path: string, bytes: string | Uint8Array) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Repeated preparation reuses an identical result; existing bytes are never replaced. */
export async function privateWriteVerified(path: string, bytes: string | Uint8Array) {
  // Publish a complete file without ever replacing an existing result.
  const staging = await mkdtemp(join(dirname(path), ".citame-write-"));
  const stagedFile = join(staging, "result");
  try {
    await chmod(staging, 0o700);
    await privateWrite(stagedFile, bytes);
    try {
      await link(stagedFile, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
          throw new Error("Existing result is not a private operator-owned regular file", {
            cause: error,
          });
        const expected = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
        if (!(await existing.readFile()).equals(expected))
          throw new Error("Existing private result differs; nothing was overwritten", {
            cause: error,
          });
      } finally {
        await existing.close();
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyArtifacts(
  root: string,
  input: Pick<BooksyTransfer, "artifacts">,
  onVerified?: (artifact: BooksyTransfer["artifacts"][number], bytes: Buffer) => void,
) {
  const base = await realpath(root);
  for (const artifact of input.artifacts) {
    if (isAbsolute(artifact.path))
      throw new Error("Artifact paths must be relative to the private archive");
    const path = await realpath(resolve(base, artifact.path));
    const local = relative(base, path);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error("Artifact escapes the private archive");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Artifact is not a regular file");
    const bytes = await readFile(path);
    if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256)
      throw new Error(`Artifact verification failed: ${artifact.path}`);
    onVerified?.(artifact, bytes);
  }
}
export async function archiveDocument(root: string, value: unknown) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const bytes = JSON.stringify(value, null, 2);
  const digest = sha(Buffer.from(bytes));
  const path = `document-${digest}.json`;
  try {
    await privateWrite(resolve(root, path), bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(resolve(root, path));
    if (sha(existing) !== digest)
      throw new Error("Existing archive document has changed", { cause: error });
  }
  return { path, sha256: digest, bytes: Buffer.byteLength(bytes) };
}
