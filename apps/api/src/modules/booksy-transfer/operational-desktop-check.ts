import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  type CalendarResponse,
  DESKTOP_CLIENT_ID,
  DESKTOP_SIGN_IN_SCOPE,
  desktopDeviceLinkResponseSchema,
  meResponseSchema,
  oauthAccessTokenResponseSchema,
  oauthConsentResponseSchema,
  type SyncChange,
  syncNudgeSchema,
  syncPullResponseSchema,
} from "@sob/contracts";
import { desktopResource } from "../../oauth/desktop";

export class OperationalDesktopProofError extends Error {}

type Request = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function readRehearsalDesktopPage(
  get: (path: string) => Response | Promise<Response>,
  generation: string,
  since: number,
) {
  const response = await get(`/sync/pull?since=${since}&limit=500&reviewRequests=1`);
  const page = syncPullResponseSchema.safeParse(await response.json());
  if (
    response.status !== 200 ||
    !page.success ||
    page.data.viewerRole !== "owner" ||
    page.data.generation !== generation ||
    page.data.nextCursor < since ||
    (page.data.hasMore && page.data.nextCursor <= since)
  )
    throw new OperationalDesktopProofError(
      "The linked desktop did not receive a valid restored sync page",
    );
  return page.data;
}

export async function collectDesktopAppointments(
  get: (path: string) => Response | Promise<Response>,
  generation: string,
  since: number,
) {
  const appointments = new Map<
    string,
    Extract<SyncChange, { entity: "appointment"; op: "upsert" }>
  >();
  let cursor = since;
  for (;;) {
    const page = await readRehearsalDesktopPage(get, generation, cursor);
    for (const change of page.changes) {
      if (change.entity !== "appointment") continue;
      if (change.op === "upsert") appointments.set(change.id, change);
      else appointments.delete(change.id);
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  return { appointments, cursor };
}

export async function hydrateRehearsalDesktop(
  get: (path: string) => Response | Promise<Response>,
  generation: string,
  calendar: CalendarResponse,
) {
  const { appointments, cursor } = await collectDesktopAppointments(get, generation, 0);
  const staff = new Set(calendar.staff.map((column) => column.id));
  const from = Date.parse(calendar.from);
  const to = Date.parse(calendar.to);
  const dayCount = [...appointments.values()].filter(
    ({ data }) =>
      staff.has(data.staffId) && Date.parse(data.startsAt) < to && Date.parse(data.endsAt) > from,
  ).length;
  if (
    dayCount !== calendar.appointments.length ||
    calendar.appointments.some((visit) => {
      const data = appointments.get(visit.id)?.data;
      return (
        !data ||
        data.staffId !== visit.staffId ||
        data.clientId !== visit.clientId ||
        data.status !== visit.status ||
        data.version !== visit.version ||
        data.visitGroupId !== visit.visitGroupId ||
        data.startsAt !== visit.startsAt ||
        data.endsAt !== visit.endsAt ||
        data.importedFromBooksy !== visit.importedFromBooksy ||
        data.services.length !== visit.services.length ||
        data.services.some((service, position) => {
          const expected = visit.services[position];
          return (
            !expected ||
            expected.serviceId !== service.serviceId ||
            expected.name !== service.name ||
            expected.durationMinutes !== service.durationMinutes ||
            expected.bufferMinutes !== service.bufferMinutes
          );
        })
      );
    })
  )
    throw new OperationalDesktopProofError(
      "The linked desktop did not receive the restored agenda",
    );
  return cursor;
}

export async function openRehearsalDesktopStream(
  get: (path: string) => Response | Promise<Response>,
) {
  const response = await get("/sync/stream");
  const reader = response.body?.getReader();
  if (
    response.status !== 200 ||
    !reader ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await reader?.cancel();
    throw new OperationalDesktopProofError("The linked desktop could not open its live stream");
  }
  const decoder = new TextDecoder();
  let pending = "";
  return {
    next: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new OperationalDesktopProofError("The linked desktop did not receive a live change"),
            ),
          4_000,
        );
      });
      try {
        for (;;) {
          const boundary = pending.indexOf("\n\n");
          if (boundary < 0) {
            const chunk = await Promise.race([reader.read(), timeout]);
            if (chunk.done)
              throw new OperationalDesktopProofError(
                "The desktop live stream closed before the change",
              );
            pending += decoder.decode(chunk.value, { stream: true });
            continue;
          }
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (!/^event: change$/m.test(frame)) continue;
          const nudge = syncNudgeSchema.safeParse(
            JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "null"),
          );
          if (!nudge.success)
            throw new OperationalDesktopProofError("The desktop live change was invalid");
          return nudge.data.seq;
        }
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => reader.cancel(),
  };
}

/** Drives the normal device authorization without opening a browser or retaining a private key. */
export async function linkOperationalRehearsalDevice(
  request: Request,
  origin: string,
  ownerCookie: string,
  userId: string,
) {
  const issuer = `${origin}/api/auth`;
  const resource = desktopResource(origin);
  const redirect = "http://127.0.0.1:8976/callback";
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: DESKTOP_CLIENT_ID,
    redirect_uri: redirect,
    resource,
    scope: DESKTOP_SIGN_IN_SCOPE,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const begin = await request(`${issuer}/oauth2/authorize?${authorize}`, {
    headers: { cookie: ownerCookie },
  });
  const next = URL.parse(begin.headers.get("location") ?? "", origin);
  if (begin.status !== 302 || next?.origin !== origin || next.pathname !== "/consent")
    throw new OperationalDesktopProofError("The rehearsal desktop did not reach OAuth consent");
  const consent = await request(`${issuer}/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie, origin },
    body: JSON.stringify({
      accept: true,
      scope: DESKTOP_SIGN_IN_SCOPE,
      oauth_query: next.search.slice(1),
    }),
  });
  const choice = oauthConsentResponseSchema.safeParse(await consent.json());
  const callback = choice.success ? URL.parse(choice.data.url) : null;
  const code = callback?.searchParams.get("code");
  if (
    consent.status !== 200 ||
    !callback ||
    `${callback.origin}${callback.pathname}` !== redirect ||
    callback.searchParams.get("iss") !== issuer ||
    callback.searchParams.get("state") !== state ||
    !code
  )
    throw new OperationalDesktopProofError(
      "The desktop OAuth callback did not match its authorization",
    );
  const exchange = await request(`${issuer}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: DESKTOP_CLIENT_ID,
      resource,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    }),
  });
  const enrollment = oauthAccessTokenResponseSchema.safeParse(await exchange.json());
  const bearer = (path: string, token: string) =>
    request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (
    exchange.status !== 200 ||
    !enrollment.success ||
    enrollment.data.refresh_token ||
    (await bearer("/sync/pull", enrollment.data.access_token)).status !== 401
  )
    throw new OperationalDesktopProofError(
      "Desktop enrollment did not issue an enrollment-only credential",
    );

  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const device = (action: string, body: object, token?: string) =>
    request(`${resource}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const linked = await device(
    "link",
    { label: "Restored agenda rehearsal", publicKey },
    enrollment.data.access_token,
  );
  const link = desktopDeviceLinkResponseSchema.safeParse(await linked.json());
  if (linked.status !== 200 || !link.success)
    throw new OperationalDesktopProofError("The rehearsal desktop key could not be linked");
  const { deviceId } = link.data;
  const signedProof = (action: "token" | "revoke") => {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const nonce = randomBytes(32).toString("base64url");
    const message = ["citame-desktop-v1", resource, deviceId, action, issuedAt, nonce].join("\n");
    return {
      deviceId,
      issuedAt,
      nonce,
      signature: sign(null, Buffer.from(message), pair.privateKey).toString("base64url"),
    };
  };
  const renew = async () => {
    const proof = signedProof("token");
    const issued = await device("token", proof);
    const access = oauthAccessTokenResponseSchema.safeParse(await issued.json());
    if (
      issued.status !== 200 ||
      !access.success ||
      access.data.refresh_token ||
      (await device("token", proof)).status !== 401
    )
      throw new OperationalDesktopProofError(
        "Device renewal or signed-proof replay protection failed",
      );
    return access.data.access_token;
  };
  let access = await renew();
  const who = await bearer("/me", access);
  const profile = meResponseSchema.safeParse(await who.json());
  if (
    who.status !== 200 ||
    !profile.success ||
    profile.data.user.id !== userId ||
    profile.data.user.role !== "owner"
  )
    throw new OperationalDesktopProofError(
      "The linked device could not resolve the restored owner",
    );
  return {
    get: (path: string) => bearer(path, access),
    renew: async () => {
      access = await renew();
    },
    revoke: async () => {
      if (
        (await device("revoke", signedProof("revoke"))).status !== 204 ||
        (await bearer("/sync/pull", access)).status !== 401 ||
        (await device("token", signedProof("token"))).status !== 404
      )
        throw new OperationalDesktopProofError("The linked device could not be revoked");
    },
  };
}
