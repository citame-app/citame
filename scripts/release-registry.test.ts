import { expect, test } from "bun:test";
import { ghcrReader, promoteReleaseImage } from "./release-registry";

const image = "ghcr.io/example/citame-api";
const revision = "a".repeat(40);
const source = "https://github.com/example/citame";
const version = "0.1.0";

function manifest(commit = revision, arm = true, variant = "") {
  const index = {
    mediaType: "application/vnd.oci.image.index.v1+json",
    annotations: {
      "org.opencontainers.image.revision": commit,
      "org.opencontainers.image.source": source,
      "org.opencontainers.image.version": version,
      fixture: variant,
    },
    manifests: (arm ? ["amd64", "arm64"] : ["amd64"]).map((architecture) => ({
      platform: { os: "linux", architecture },
    })),
  };
  const bytes = JSON.stringify(index);
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  return { index, digest, bytes };
}

test("publishes the attested digest and verifies the published tag", async () => {
  const built = manifest();
  let existing: typeof built | null = null;
  const calls: string[] = [];
  const result = await promoteReleaseImage(
    { image, revision, version, digest: built.digest, source },
    async (ref) => {
      calls.push(`read ${ref}`);
      return ref === version ? existing : built;
    },
    (ref) => calls.push(`verify ${ref}`),
    (tag, ref) => {
      calls.push(`create ${tag} ${ref}`);
      existing = built;
    },
  );
  expect(result).toBe(built.digest);
  expect(calls).toEqual([
    `read ${version}`,
    `read ${built.digest}`,
    `verify ${image}@${built.digest}`,
    `read ${version}`,
    `create ${image}:${version} ${image}@${built.digest}`,
    `read ${version}`,
  ]);
});

test("checks for a version tag again after provenance verification before promotion", async () => {
  const built = manifest();
  const previous = manifest(revision, true, "concurrent valid image");
  let versionReads = 0;
  const verified: string[] = [];
  const result = await promoteReleaseImage(
    { image, revision, version, digest: built.digest, source },
    async (ref) => (ref === version ? (++versionReads === 1 ? null : previous) : built),
    (ref) => verified.push(ref),
    () => {
      throw new Error("must not replace an image");
    },
  );
  expect(result).toBe(previous.digest);
  expect(verified).toEqual([`${image}@${built.digest}`, `${image}@${previous.digest}`]);
});

test("a rerun reuses only an attested digest for the same revision and leaves its tag alone", async () => {
  const published = manifest();
  const rebuild = manifest(revision, true, "new bytes");
  expect(rebuild.digest).not.toBe(published.digest);
  const verify: string[] = [];
  expect(
    await promoteReleaseImage(
      { image, revision, version, digest: rebuild.digest, source },
      async (ref) => {
        expect(ref).toBe(version);
        return published;
      },
      (ref) => verify.push(ref),
      () => {
        throw new Error("must not replace an image");
      },
    ),
  ).toBe(published.digest);
  expect(verify).toEqual([`${image}@${published.digest}`]);
});

test("blocks a foreign or incomplete image and a failed provenance check before mutation", async () => {
  const valid = manifest();
  const options = { image, revision, version, digest: valid.digest, source };
  const noWrite = () => {
    throw new Error("unexpected registry write");
  };
  for (const bad of [manifest("b".repeat(40)), manifest(revision, false)]) {
    await expect(
      promoteReleaseImage(
        options,
        async () => bad,
        () => {},
        noWrite,
      ),
    ).rejects.toThrow("expected release");
  }
  await expect(
    promoteReleaseImage(
      options,
      async () => valid,
      () => {
        throw new Error("unsigned image");
      },
      noWrite,
    ),
  ).rejects.toThrow("unsigned image");
  await expect(
    promoteReleaseImage(
      options,
      async (ref) => (ref === version ? null : valid),
      () => {
        throw new Error("unsigned image");
      },
      noWrite,
    ),
  ).rejects.toThrow("unsigned image");
});

test("registry reads fail closed unless GHCR identifies an absent manifest", async () => {
  const data = manifest();
  const okay = () =>
    new Response(data.bytes, { headers: { "docker-content-digest": data.digest } });
  const withResponse = (next: () => Response) =>
    ghcrReader(image, "runner", "fake", async (input, options) => {
      const url = new URL(input);
      expect(url.host).toBe("ghcr.io");
      expect(options?.redirect).toBe("error");
      if (url.pathname === "/token") {
        expect(url.searchParams.get("scope")).toBe("repository:example/citame-api:pull");
        return Response.json({ token: "fixture" });
      }
      return next();
    });
  expect((await withResponse(okay)(data.digest))?.digest).toBe(data.digest);
  expect(
    await withResponse(() =>
      Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 }),
    )(version),
  ).toBeNull();
  for (const status of [403, 404, 429, 500]) {
    await expect(withResponse(() => Response.json({}, { status }))(version)).rejects.toThrow(
      `HTTP ${status}`,
    );
  }
  await expect(withResponse(okay)(`sha256:${"a".repeat(64)}`)).rejects.toThrow("unexpected bytes");
});
