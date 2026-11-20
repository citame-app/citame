import { mkdir, writeFile } from "node:fs/promises";
import { verifyReleaseTag } from "./release";

const indexType = "application/vnd.oci.image.index.v1+json";
const manifestTypes = [
  indexType,
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function ghcrReader(
  image: string,
  actor: string,
  credential: string,
  request: (input: string | URL, options?: RequestInit) => Promise<Response> = fetch,
) {
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+-(api|web)$/.test(image))
    throw new Error("Invalid release image path");
  if (!actor || !credential) throw new Error("Registry credentials are required");
  const repository = image.slice("ghcr.io/".length);
  return async (ref: string) => {
    if (!digestPattern.test(ref) && !/^[\dA-Za-z.-]+$/.test(ref))
      throw new Error("Invalid registry reference");
    const auth = new URL("https://ghcr.io/token");
    auth.searchParams.set("service", "ghcr.io");
    auth.searchParams.set("scope", `repository:${repository}:pull`);
    const login = await request(auth, {
      headers: {
        authorization: `Basic ${Buffer.from(`${actor}:${credential}`).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!login.ok) throw new Error(`Registry authentication failed (HTTP ${login.status})`);
    const { token } = (await login.json()) as { token?: string };
    if (!token) throw new Error("Registry authentication did not return a token");
    const response = await request(`https://ghcr.io/v2/${repository}/manifests/${ref}`, {
      headers: { accept: manifestTypes, authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      const body = (await response.json()) as { errors?: { code?: string }[] };
      if (body.errors?.some(({ code }) => code === "MANIFEST_UNKNOWN")) return null;
    }
    if (response.status !== 200)
      throw new Error(`Cannot read ${image}:${ref} (HTTP ${response.status})`);
    const bytes = await response.arrayBuffer();
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    if (
      response.headers.get("docker-content-digest") !== digest ||
      (digestPattern.test(ref) && ref !== digest)
    )
      throw new Error(`Registry returned unexpected bytes for ${image}:${ref}`);
    const index = JSON.parse(new TextDecoder().decode(bytes)) as {
      mediaType?: string;
      annotations?: Record<string, string>;
      manifests?: { platform?: { os?: string; architecture?: string } }[];
    };
    return { digest, index };
  };
}

type ImageReader = ReturnType<typeof ghcrReader>;

export async function promoteReleaseImage(
  {
    image,
    version,
    revision,
    digest,
    source,
  }: Record<"image" | "version" | "revision" | "digest" | "source", string>,
  read: ImageReader,
  verify: (ref: string) => void,
  create: (tag: string, image: string) => void,
) {
  if (!digestPattern.test(digest)) throw new Error("Missing or invalid build digest");
  function validate(manifest: Awaited<ReturnType<ImageReader>>) {
    if (
      manifest?.index.mediaType !== indexType ||
      manifest.index.annotations?.["org.opencontainers.image.revision"] !== revision ||
      manifest.index.annotations?.["org.opencontainers.image.version"] !== version ||
      manifest.index.annotations?.["org.opencontainers.image.source"] !== source ||
      !["amd64", "arm64"].every((architecture) =>
        manifest.index.manifests?.some(
          ({ platform }) => platform?.os === "linux" && platform.architecture === architecture,
        ),
      )
    )
      throw new Error(
        `Image ${image} does not match the expected release source, version or platforms`,
      );
    return manifest.digest;
  }

  const existing = await read(version);
  if (existing) {
    const published = validate(existing);
    verify(`${image}@${published}`);
    return published;
  }

  const built = validate(await read(digest));
  if (built !== digest) throw new Error("Registry image does not match the build digest");
  const reference = `${image}@${digest}`;
  verify(reference);
  // A registry writer may have completed while provenance verification was running.
  const concurrent = await read(version);
  if (concurrent) {
    const published = validate(concurrent);
    if (published !== digest) verify(`${image}@${published}`);
    return published;
  }
  create(`${image}:${version}`, reference);
  if (validate(await read(version)) !== digest)
    throw new Error("Registry tag does not match the verified image digest");
  return digest;
}

function run(command: string[], failure: string): void {
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(failure);
}

async function cli() {
  const {
    GITHUB_ACTOR = "",
    GITHUB_REPOSITORY = "",
    GH_TOKEN = "",
    RELEASE_IMAGE = "",
    RELEASE_TAG = "",
    RELEASE_VERSION = "",
    RELEASE_REVISION = "",
    RELEASE_DIGEST = "",
  } = process.env;
  verifyReleaseTag(process.cwd(), RELEASE_TAG, RELEASE_REVISION);
  const read = ghcrReader(RELEASE_IMAGE, GITHUB_ACTOR, GH_TOKEN);
  const verify = (reference: string) => {
    run(
      [
        "gh",
        "attestation",
        "verify",
        `oci://${reference}`,
        "--repo",
        GITHUB_REPOSITORY,
        "--source-digest",
        RELEASE_REVISION,
        "--source-ref",
        `refs/tags/${RELEASE_TAG}`,
        "--signer-workflow",
        `${GITHUB_REPOSITORY}/.github/workflows/release.yml`,
      ],
      "Image provenance verification failed",
    );
  };
  if (process.argv[2] === "verify") {
    if (
      !digestPattern.test(RELEASE_DIGEST) ||
      (await read(RELEASE_VERSION))?.digest !== RELEASE_DIGEST
    )
      throw new Error(
        `${RELEASE_IMAGE}:${RELEASE_VERSION} no longer resolves to the recorded digest`,
      );
    verify(`${RELEASE_IMAGE}@${RELEASE_DIGEST}`);
    return;
  }
  if (process.argv.length > 2) throw new Error("Usage: bun scripts/release-registry.ts [verify]");
  const digest = await promoteReleaseImage(
    {
      image: RELEASE_IMAGE,
      version: RELEASE_VERSION,
      revision: RELEASE_REVISION,
      digest: RELEASE_DIGEST,
      source: `https://github.com/${GITHUB_REPOSITORY}`,
    },
    read,
    verify,
    (tag, reference) => {
      verifyReleaseTag(process.cwd(), RELEASE_TAG, RELEASE_REVISION);
      run(
        ["docker", "buildx", "imagetools", "create", "--tag", tag, reference],
        "Image publication failed",
      );
    },
  );
  const kind = RELEASE_IMAGE.endsWith("-api") ? "api" : "web";
  await mkdir(".release/images", { recursive: true });
  await writeFile(`.release/images/${kind}.digest`, `${digest}\n`);
}

if (import.meta.main) {
  try {
    await cli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Image release failed");
    process.exitCode = 1;
  }
}
