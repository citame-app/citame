import { type Database, jwks, oauthResource } from "@sob/db";
import type { Jwk } from "better-auth/plugins/jwt";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { AppConfig } from "../config";
import { desktopResource } from "../oauth/desktop";
import { type Auth, OAUTH_JWKS_GRACE_SECONDS } from "./auth";

type SignJWT = Auth["api"]["signJWT"];

export class OAuthSigningKeyError extends Error {
  constructor() {
    super("Cannot use the OAuth signing key. Check BETTER_AUTH_SECRET and the selected database.");
  }
}

export async function verifyExistingOAuthSigningKey(
  db: Database,
  signJWT: SignJWT,
  config: Pick<AppConfig, "auth" | "oauth">,
) {
  const resourceIds = [config.oauth.mcpResource, desktopResource(config.auth.baseURL)];
  const now = Date.now();
  const graceCutoff = new Date(now - OAUTH_JWKS_GRACE_SECONDS * 1_000);
  const [keys, policies] = await Promise.all([
    db
      .select()
      .from(jwks)
      .where(or(isNull(jwks.expiresAt), gt(jwks.expiresAt, graceCutoff))),
    db
      .select({ alg: oauthResource.signingAlgorithm, kid: oauthResource.signingKeyId })
      .from(oauthResource)
      .where(
        and(
          inArray(oauthResource.identifier, resourceIds),
          or(isNull(oauthResource.disabled), eq(oauthResource.disabled, false)),
        ),
      ),
  ]);
  if (policies.some(({ alg }) => alg && alg !== "ES256")) throw new OAuthSigningKeyError();
  const pinnedIds = new Set(policies.flatMap(({ kid }) => (kid ? [kid] : [])));
  const activeKeys = keys.filter(({ expiresAt }) => !expiresAt || expiresAt.getTime() > now);

  try {
    // Include rotated public keys that clients can still receive from JWKS.
    const publicKeys = createLocalJWKSet({
      keys: keys.map((key) => ({
        alg: key.alg ?? "ES256",
        crv: key.crv ?? undefined,
        ...JSON.parse(key.publicKey),
        kid: key.id,
      })),
    });
    if (!activeKeys.length && !pinnedIds.size) return; // Leave first-use provisioning to Better Auth.
    const signingKeys = activeKeys
      .filter((key) => key.alg === null || key.alg === "ES256")
      .map(({ id, publicKey, privateKey, createdAt, expiresAt }) => ({
        id,
        publicKey,
        privateKey,
        createdAt,
        expiresAt: expiresAt ?? undefined,
        alg: "ES256" as const,
      }));
    const defaultKey = await verifySigningRoundTrip(signJWT, signingKeys, publicKeys);
    for (const pinnedId of pinnedIds) {
      if (pinnedId !== defaultKey) {
        await verifySigningRoundTrip(
          signJWT,
          signingKeys.filter((key) => key.id === pinnedId),
          publicKeys,
        );
      }
    }
  } catch {
    throw new OAuthSigningKeyError();
  }
}

async function verifySigningRoundTrip(
  signJWT: SignJWT,
  signingKeys: Jwk[],
  publicKeys: ReturnType<typeof createLocalJWKSet>,
) {
  if (!signingKeys.length) throw new OAuthSigningKeyError();
  const audience = "urn:citame:startup";
  const { token } = await signJWT({
    body: {
      payload: { aud: audience, exp: Math.floor(Date.now() / 1000) + 5 },
      overrideOptions: {
        adapter: {
          getJwks: async () => signingKeys,
          createJwk: () => {
            throw new OAuthSigningKeyError();
          },
        },
      },
    },
  });
  const { kid, alg } = decodeProtectedHeader(token);
  if (!kid || alg !== "ES256" || !signingKeys.some((key) => key.id === kid))
    throw new OAuthSigningKeyError();
  await jwtVerify(token, publicKeys, { audience, algorithms: [alg] });
  return kid;
}
