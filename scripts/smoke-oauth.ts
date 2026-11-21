import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  appointmentContextSchema,
  DESKTOP_CLIENT_ID,
  DESKTOP_SIGN_IN_SCOPE,
  desktopDevicesSchema,
  meResponseSchema,
  reportClientsSchema,
  reportOutcomesPageSchema,
  reportSummarySchema,
  salesReportSchema,
  syncPullResponseSchema,
} from "../packages/contracts/src";

const origin = process.env.PUBLIC_URL;
assert(
  origin && new URL(origin).origin === origin && new URL(origin).hostname === "localhost",
  "Run against the smoke stack on localhost",
);
const resource = `${origin}/mcp`;
const issuer = `${origin}/api/auth`;
const redirectUri = "http://127.0.0.1:8976/callback";
const scope = "mcp:read operations:read";
const [, , jar, bookingId, startsAt, clientJar, outcomeFixture] = Bun.argv;
assert(
  jar && bookingId && startsAt && clientJar && outcomeFixture,
  "Pass the smoke cookie jars, synthetic booking and report fixture",
);
const outcomes = JSON.parse(outcomeFixture) as {
  date: string;
  ids: { no_show: string; cancelled: string };
};
assert(/^\d{4}-\d{2}-\d{2}$/.test(outcomes.date));
assert(outcomes.ids?.no_show && outcomes.ids.cancelled, "Missing synthetic outcomes");

async function readCookies(path: string) {
  return (await Bun.file(path).text())
    .split("\n")
    .map((line) => line.replace(/^#HttpOnly_/, ""))
    .filter((line) => line.startsWith("localhost\t"))
    .map((line) => line.split("\t").slice(5).join("="))
    .join("; ");
}

const cookie = await readCookies(jar);
const otherBrowserCookie = await readCookies(clientJar);
assert(cookie, "The smoke owner has no session cookie");
assert(otherBrowserCookie, "The smoke client has no session cookie");

const request = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(10000) });
const jsonHeaders = { "content-type": "application/json" };
const metadata = await request(`${origin}/.well-known/oauth-authorization-server/api/auth`);
assert.equal(metadata.status, 200, "Authorization server discovery");
const discovery = (await metadata.json()) as {
  issuer: string;
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
};
assert.equal(discovery.issuer, issuer);
assert(discovery.code_challenge_methods_supported.includes("S256"));
assert(discovery.scopes_supported.includes("billing:write"), "OAuth billing scope is missing");

const register = await request(`${issuer}/oauth2/register`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({
    client_name: "Production smoke test",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    scope,
  }),
});
assert.equal(register.status, 201, "MCP client registration");
const { client_id: clientId } = (await register.json()) as { client_id: unknown };
assert(typeof clientId === "string", "OAuth registration did not return a client ID");

async function readTokens(response: Response) {
  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  assert(
    typeof body.access_token === "string" && body.access_token,
    "OAuth did not issue an access token",
  );
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

async function authorizeCode(clientId: string, resource: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorize = await request(`${issuer}/oauth2/authorize?${query}`, { headers: { cookie } });
  assert.equal(authorize.status, 302, "Redirect to consent or return to the desktop client");
  const next = new URL(authorize.headers.get("location") ?? "", origin);
  let callback = next;
  if (next.origin === origin && next.pathname === "/consent") {
    assert.equal((await request(next.href, { headers: { cookie } })).status, 200);
    const consent = await request(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: { ...jsonHeaders, cookie, origin },
      body: JSON.stringify({ accept: true, scope, oauth_query: next.search.slice(1) }),
    });
    assert.equal(consent.status, 200, "Consent for the requested grant");
    callback = new URL(((await consent.json()) as { url: string }).url);
  }
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
  assert.equal(callback.searchParams.get("iss"), issuer);
  assert(callback.searchParams.get("state") === state, "OAuth callback state does not match");
  const code = callback.searchParams.get("code");
  assert(code, "OAuth callback did not contain a code");

  const token = await request(`${issuer}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(token.status, 200, "Exchange the PKCE authorization code");
  return readTokens(token);
}
const { accessToken } = await authorizeCode(clientId, resource, scope);
const rpc = (method: string, params?: object) =>
  request(resource, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const listed = await rpc("tools/list");
assert.equal(listed.status, 200, "List tools through the production proxy");
const { result } = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
const names = result.tools.map((tool: { name: string }) => tool.name);
assert(names.includes("get_calendar"), "Calendar tool missing from the read grant");
assert(
  names.includes("find_reschedule_availability"),
  "Rescheduling lookup missing from the read grant",
);
assert(
  names.includes("get_imported_price_review"),
  "Owner billing lookup missing from the read grant",
);
assert(!names.includes("create_time_off"), "Read grant includes an unauthorized calendar write");
assert(!names.includes("record_commission_payout"), "Read grant includes commission writes");
assert(!names.includes("record_imported_price_review"), "Read grant includes billing writes");
assert(names.includes("list_service_combinations"), "Catalogue combinations are missing");
assert(!names.includes("configure_service"), "Read grant includes catalogue writes");
assert(!names.includes("record_cash_movement"), "Read grant includes cash adjustments");

const calendar = await rpc("tools/call", {
  name: "get_calendar",
  arguments: {
    from: startsAt,
    to: new Date(Date.parse(startsAt) + 24 * 60 * 60 * 1000).toISOString(),
  },
});
assert.equal(calendar.status, 200, "Read the calendar via MCP");
const calendarTool = (
  (await calendar.json()) as {
    result?: { structuredContent?: { data?: { appointments: Array<{ id: string }> } } };
  }
).result;
const booking = calendarTool?.structuredContent?.data?.appointments.find(
  (row: { id: string }) => row.id === bookingId,
);
assert(booking, "The synthetic booking is missing from the MCP calendar");
assert(!("notes" in booking), "MCP leaked calendar notes");

const revoked = await request(`${origin}/api/me/connections/${encodeURIComponent(clientId)}`, {
  method: "DELETE",
  headers: { cookie, origin },
});
assert.equal(revoked.status, 204, "Revoke the OAuth grant in the owner account");
assert.equal(
  (await rpc("tools/list")).status,
  401,
  "Revocation did not invalidate the access token",
);

const desktopResource = `${issuer}/desktop`;
const desktop = await authorizeCode(
  DESKTOP_CLIENT_ID,
  desktopResource,
  `${DESKTOP_SIGN_IN_SCOPE} offline_access`,
);
assert(desktop.refreshToken, "Desktop OAuth did not issue a refresh token");
const desktopRequest = (path: string, token: string) =>
  request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
const desktopOwner = await desktopRequest("/me", desktop.accessToken);
assert.equal(desktopOwner.status, 200, "Resolve the desktop owner with the bearer token alone");
const desktopUser = meResponseSchema.parse(await desktopOwner.json()).user;
assert.equal(desktopUser.role, "owner");
const replica = await desktopRequest("/sync/pull?since=0&limit=500", desktop.accessToken);
assert.equal(replica.status, 200, "Pull through the native proxy path using OAuth");
const snapshot = syncPullResponseSchema.parse(await replica.json());
assert(snapshot.changes.some((row) => row.entity === "appointment" && row.id === bookingId));

const stream = await desktopRequest("/sync/stream", desktop.accessToken);
assert.equal(stream.status, 200, "Open the native SSE path using OAuth");
assert(stream.headers.get("content-type")?.includes("text/event-stream"));
const reader = stream.body?.getReader();
assert(reader, "Missing desktop stream body");
try {
  let initial = "";
  const decoder = new TextDecoder();
  while (!initial.includes("\n\n")) {
    const next = await reader.read();
    assert(!next.done, "Desktop stream closed before sending its head");
    initial += decoder.decode(next.value, { stream: true });
  }
  assert(initial.includes("event: change"), "Desktop stream did not send its head");
} finally {
  await reader.cancel();
}
assert.equal(
  (await desktopRequest("/mcp", desktop.accessToken)).status,
  401,
  "Desktop token was accepted by MCP",
);

const refresh = await request(`${issuer}/oauth2/token`, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: DESKTOP_CLIENT_ID,
    refresh_token: desktop.refreshToken,
    resource: desktopResource,
  }),
});
assert.equal(refresh.status, 200, "Refresh desktop authorization through Caddy");
const rotated = await readTokens(refresh);
assert(
  rotated.refreshToken && rotated.refreshToken !== desktop.refreshToken,
  "Desktop refresh token did not rotate",
);
assert.equal((await desktopRequest("/sync/pull", rotated.accessToken)).status, 200);
assert.equal(
  (
    await request(`${origin}/api/me/connections/${DESKTOP_CLIENT_ID}`, {
      method: "DELETE",
      headers: { cookie, origin },
    })
  ).status,
  204,
  "Revoke the desktop OAuth connection",
);
assert.equal((await desktopRequest("/sync/pull", rotated.accessToken)).status, 401);

const deviceRequest = (action: string, body: object, token?: string) =>
  request(`${desktopResource}/${action}`, {
    method: "POST",
    headers: { ...jsonHeaders, ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

async function linkDevice(label: string) {
  const bootstrap = await authorizeCode(DESKTOP_CLIENT_ID, desktopResource, DESKTOP_SIGN_IN_SCOPE);
  assert.equal(
    bootstrap.refreshToken,
    undefined,
    "Enrollment must use the desktop key for renewal",
  );
  assert.equal((await desktopRequest("/sync/pull", bootstrap.accessToken)).status, 401);
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const response = await deviceRequest("link", { label, publicKey }, bootstrap.accessToken);
  assert.equal(response.status, 200, "Enroll a desktop key through the production proxy");
  const { deviceId } = (await response.json()) as { deviceId: string };

  function proof(action: "token" | "revoke" | "browser-ticket", binding: string[] = []) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(32).toString("base64url");
    const payload = [
      "citame-desktop-v1",
      desktopResource,
      deviceId,
      action,
      issuedAt,
      nonce,
      ...binding,
    ].join("\n");
    return {
      deviceId,
      issuedAt,
      nonce,
      signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64url"),
    };
  }

  async function renew() {
    const signed = proof("token");
    const result = await deviceRequest("token", signed);
    assert.equal(result.status, 200, "Renew the device authorization");
    assert.equal((await deviceRequest("token", signed)).status, 401, "Reject a reused proof");
    return (await readTokens(result)).accessToken;
  }

  return { deviceId, proof, renew };
}

async function linkedDeviceIds() {
  const response = await request(`${origin}/api/me/desktop-devices`, { headers: { cookie } });
  assert.equal(response.status, 200, "List the owner's desktop devices through the cloud API");
  return desktopDevicesSchema.parse(await response.json()).devices.map((device) => device.id);
}

const reception = await linkDevice("Synthetic reception");
const office = await linkDevice("Synthetic office");
const reserve = await linkDevice("Synthetic reserve device");
const browserOrigin = "http://127.0.0.1:54321";
const browserCalendar = { date: "2026-11-18", view: "day" };
const browserTicket = await deviceRequest("browser-ticket", {
  proof: reception.proof("browser-ticket", [
    browserOrigin,
    browserCalendar.date,
    browserCalendar.view,
    "",
  ]),
  origin: browserOrigin,
  calendar: browserCalendar,
});
assert.equal(browserTicket.status, 200, "Issue a one-use browser handoff through the proxy");
const { ticket } = (await browserTicket.json()) as { ticket: string };
const otherBrowserUser = await request(`${origin}/api/me`, {
  headers: { cookie: otherBrowserCookie },
});
assert.equal(otherBrowserUser.status, 200);
const otherUser = meResponseSchema.parse(await otherBrowserUser.json()).user;
assert.equal(otherUser.role, "client");
assert.notEqual(otherUser.id, desktopUser.id);
const redeem = (code = ticket) =>
  request(`${desktopResource}/browser`, {
    method: "POST",
    headers: {
      origin: browserOrigin,
      "content-type": "application/x-www-form-urlencoded",
      cookie: otherBrowserCookie,
    },
    body: new URLSearchParams({ ticket: code }).toString(),
  });
const browserSession = await redeem();
assert.equal(browserSession.status, 303, "Open the calendar from the linked device");
assert.equal(browserSession.headers.get("location"), "/admin/calendar?date=2026-11-18&view=day");
const browserCookie = browserSession.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert(browserCookie.includes("session_token="));
const browserUser = await request(`${origin}/api/me`, { headers: { cookie: browserCookie } });
assert.equal(browserUser.status, 200);
assert.deepEqual(
  meResponseSchema.parse(await browserUser.json()).user,
  desktopUser,
  "The browser calendar must use the desktop account even with a different existing web session",
);
const browserPage = await request(`${origin}${browserSession.headers.get("location")}`, {
  headers: { cookie: browserCookie },
});
assert.equal(browserPage.status, 200, "The browser session can open the agenda");
assert.equal((await redeem()).status, 401, "The handoff cannot be used twice");
const selectedStaff = [
  "a4a08ac9-d3ce-4c1b-be6a-eb8a764cf78f",
  "716df2ff-67ba-473a-8c17-c1bfd5b7cf1d",
].join(",");
for (const view of ["month", "list"]) {
  const calendar = { date: "2026-11-18", view, staff: selectedStaff };
  const response = await deviceRequest("browser-ticket", {
    proof: reception.proof("browser-ticket", [browserOrigin, calendar.date, view, selectedStaff]),
    origin: browserOrigin,
    calendar,
  });
  assert.equal(response.status, 200, `Issue a ${view} handoff with both professionals`);
  const { ticket: code } = (await response.json()) as { ticket: string };
  const session = await redeem(code);
  assert.equal(session.status, 303);
  const location = new URL(session.headers.get("location") ?? "", origin);
  assert.equal(location.pathname, "/admin/calendar");
  assert.equal(location.searchParams.get("view"), view);
  assert.equal(location.searchParams.get("date"), calendar.date);
  assert.equal(location.searchParams.get("staff"), selectedStaff);
  const sessionCookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const user = await request(`${origin}/api/me`, { headers: { cookie: sessionCookie } });
  assert.equal(user.status, 200);
  assert.deepEqual(meResponseSchema.parse(await user.json()).user, desktopUser);
}
assert.deepEqual(
  new Set(await linkedDeviceIds()),
  new Set([reception.deviceId, office.deviceId, reserve.deviceId]),
);
const receptionToken = await reception.renew();
const officeToken = await office.renew();
const durableReplica = await desktopRequest("/sync/pull?since=0&limit=500", receptionToken);
assert.equal(durableReplica.status, 200, "The device token can read the native replica");
assert(
  syncPullResponseSchema
    .parse(await durableReplica.json())
    .changes.some((row) => row.entity === "appointment" && row.id === bookingId),
  "The linked device must receive the synthetic booking",
);
assert.equal((await desktopRequest("/mcp", receptionToken)).status, 401);

const dateFilters = new URLSearchParams({ from: outcomes.date, to: outcomes.date });
const summaryResponse = await desktopRequest(
  `/admin/reports/summary?${dateFilters}`,
  receptionToken,
);
assert.equal(summaryResponse.status, 200, "The linked device can open Reports");
const reportSummary = reportSummarySchema.parse(await summaryResponse.json());
assert.equal(reportSummary.canReportClients, true, "The linked owner can open the client report");
const clientReportPath = `/admin/reports/clients?${dateFilters}`;
const nativeClients = await desktopRequest(clientReportPath, receptionToken);
assert.equal(nativeClients.status, 200, "The proxy forwards the client report to the API");
assert.equal(nativeClients.headers.get("cache-control"), "private, no-store");
const clients = reportClientsSchema.parse(await nativeClients.json());
assert.deepEqual(clients.totals, { newClients: 1, returningClients: 1 });
assert.deepEqual(clients.rows, [{ date: outcomes.date, newClients: 1, returningClients: 1 }]);
assert.deepEqual(clients.frequency, { one: 2, two: 0, threeOrMore: 0 });
const webClients = await request(`${origin}/api${clientReportPath}`, { headers: { cookie } });
assert.equal(webClients.status, 200);
assert.deepEqual(
  reportClientsSchema.parse(await webClients.json()),
  clients,
  "Web and desktop see the same clients",
);
assert.equal(
  (await request(`${origin}/api${clientReportPath}`, { headers: { cookie: otherBrowserCookie } }))
    .status,
  403,
  "Customers cannot read the private client report",
);
const financialPath = `/admin/accounting/sales?${dateFilters}`;
const nativeFinancial = await desktopRequest(financialPath, receptionToken);
assert.equal(nativeFinancial.status, 200, "The linked owner can open financial reports");
assert.equal(nativeFinancial.headers.get("cache-control"), "private, no-store");
const webFinancial = await request(`${origin}/api${financialPath}`, { headers: { cookie } });
assert.equal(webFinancial.status, 200);
assert.deepEqual(
  salesReportSchema.parse(await nativeFinancial.json()),
  salesReportSchema.parse(await webFinancial.json()),
);
assert.equal(
  (await request(`${origin}/api${financialPath}`, { headers: { cookie: otherBrowserCookie } }))
    .status,
  403,
);
for (const status of ["cancelled", "no_show"] as const) {
  const filters = new URLSearchParams(dateFilters);
  filters.set("status", status);
  const listPath = `/admin/reports/outcomes?${filters}`;
  const exportPath = `/admin/reports/outcomes/export?${filters}`;
  assert.equal(reportSummary.totals.byStatus[status], 1);
  const nativeList = await desktopRequest(listPath, receptionToken);
  assert.equal(nativeList.status, 200, "Open the filtered list through the native proxy route");
  const list = reportOutcomesPageSchema.parse(await nativeList.json());
  assert.equal(list.total, 1);
  assert.deepEqual(
    list.rows.map((row) => row.id),
    [outcomes.ids[status]],
  );
  const nativeCsv = await desktopRequest(exportPath, receptionToken);
  assert.equal(nativeCsv.status, 200, "Export the filtered report with the device token");
  assert(nativeCsv.headers.get("content-disposition")?.includes(`appointments-${status}-`));
  assert(nativeCsv.headers.get("cache-control")?.includes("private, no-store"));
  const csv = await nativeCsv.text();
  assert(csv.includes(`"${outcomes.ids[status]}","${status}"`));
  const otherStatus = status === "cancelled" ? "no_show" : "cancelled";
  assert(!csv.includes(outcomes.ids[otherStatus]));
  const ownerCsv = await request(`${origin}/api${exportPath}`, { headers: { cookie } });
  assert.equal(ownerCsv.status, 200);
  assert.equal(await ownerCsv.text(), csv, "Web and desktop export the same data");
  const clientCsv = await request(`${origin}/api${exportPath}`, {
    headers: { cookie: otherBrowserCookie },
  });
  assert.equal(clientCsv.status, 403, "Customers cannot export private appointment outcomes");
}

const durableStream = await request(`${origin}/sync/stream`, {
  headers: { authorization: `Bearer ${receptionToken}` },
  signal: AbortSignal.timeout(35_000),
});
assert.equal(durableStream.status, 200, "The device token can open SSE");
assert(durableStream.headers.get("content-type")?.includes("text/event-stream"));
const durableReader = durableStream.body?.getReader();
assert(durableReader);
const decoder = new TextDecoder();
let pending = "";
async function nextSequence() {
  assert(durableReader);
  for (;;) {
    const boundary = pending.indexOf("\n\n");
    if (boundary !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      if (!/^event: change$/m.test(frame)) continue;
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      assert(data);
      const { seq } = JSON.parse(data) as { seq: number };
      assert(Number.isSafeInteger(seq), "Invalid SSE cursor");
      return seq;
    }
    const chunk = await durableReader.read();
    if (chunk.done) throw new Error("Desktop stream closed before delivering the change");
    pending += decoder.decode(chunk.value, { stream: true });
  }
}

try {
  const before = await nextSequence();
  const contextUrl = `${origin}/api/appointments/${bookingId}/context`;
  const contextRead = await request(contextUrl, { headers: { cookie } });
  assert.equal(contextRead.status, 200, "Get the synthetic booking's current version");
  const { appointmentVersion, rows } = appointmentContextSchema.parse(await contextRead.json());
  const note = "Private synthetic production smoke note";
  const change = await request(contextUrl, {
    method: "PATCH",
    headers: { ...jsonHeaders, cookie, origin },
    body: JSON.stringify({
      appointmentVersion,
      servicePosition: 0,
      version: rows.find((row) => row.servicePosition === 0)?.version ?? 0,
      internalNote: note,
    }),
  });
  assert.equal(
    change.status,
    200,
    "Update a synthetic appointment while the desktop stream is open",
  );
  assert((await nextSequence()) > before, "The desktop stream must signal the committed update");
  const updated = await desktopRequest(`/sync/pull?since=${before}&limit=500`, receptionToken);
  assert.equal(updated.status, 200);
  const json = await updated.text();
  assert(!json.includes(note), "The desktop replica must not carry private notes");
  assert(
    syncPullResponseSchema
      .parse(JSON.parse(json))
      .changes.some((row) => row.entity === "appointment" && row.id === bookingId),
    "After a live event the incremental pull must include the updated appointment",
  );

  const disconnect = await request(`${origin}/api/me/desktop-devices/${reception.deviceId}`, {
    method: "DELETE",
    headers: { cookie, origin },
  });
  assert.equal(disconnect.status, 204, "Disconnect a device from the owner account");
  assert.equal((await desktopRequest("/sync/pull", receptionToken)).status, 401);
  assert.equal((await desktopRequest(clientReportPath, receptionToken)).status, 401);
  assert.equal(
    (
      await desktopRequest(
        `/admin/reports/outcomes/export?${dateFilters}&status=no_show`,
        receptionToken,
      )
    ).status,
    401,
    "Revoked desktop credentials cannot export client information",
  );
  assert.equal((await deviceRequest("token", reception.proof("token"))).status, 404);
  while (!(await durableReader.read()).done) {
    // The authorization heartbeat closes the stream even when no more changes arrive.
  }
} finally {
  await durableReader.cancel().catch(() => {});
}
assert.deepEqual(new Set(await linkedDeviceIds()), new Set([office.deviceId, reserve.deviceId]));
assert.equal((await desktopRequest("/sync/pull", officeToken)).status, 200);
assert.equal((await desktopRequest("/sync/pull", await office.renew())).status, 200);

assert.equal((await deviceRequest("revoke", office.proof("revoke"))).status, 204);
assert.equal((await desktopRequest("/sync/pull", officeToken)).status, 401);
assert.equal((await deviceRequest("token", office.proof("token"))).status, 404);
assert.deepEqual(await linkedDeviceIds(), [reserve.deviceId]);
assert.equal((await desktopRequest("/sync/pull", await reserve.renew())).status, 200);
assert.equal((await deviceRequest("revoke", reserve.proof("revoke"))).status, 204);
assert.deepEqual(await linkedDeviceIds(), []);
