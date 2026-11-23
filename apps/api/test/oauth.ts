import type { Hono } from "hono";
import type { Actor, ApiTest } from "./helpers";

export const ORIGIN = "http://localhost:3000";
export const ISSUER = `${ORIGIN}/api/auth`;
export const MCP_URL = `${ORIGIN}/mcp`;
export const REDIRECT_URI = "http://127.0.0.1:8976/callback";

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function pkce(): Promise<Pkce> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  [key: string]: unknown;
}

/** RFC 7591 dynamic client registration, the way an MCP client does it (no credentials). */
export async function registerClient(
  app: Hono,
  overrides: Record<string, unknown> = {},
): Promise<{ res: Response; client: RegisteredClient }> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read mcp:book offline_access",
      ...overrides,
    }),
  });
  const client = (await res.json()) as RegisteredClient;
  return { res, client };
}

export interface FlowOptions {
  clientId: string;
  cookie: string;
  scope: string;
  resource?: string | null;
  redirectUri?: string;
  approve?: boolean;
  acceptedScope?: string;
  codeChallenge?: string;
  challengeMethod?: string;
}

export interface FlowResult {
  /** The authorization response (redirect to consent or to the client). */
  authorize: Response;
  /** Where the user agent ended up: the client redirect URI with `code` or `error`. */
  finalUrl: URL | null;
  code: string | null;
  verifier: string;
}

/**
 * Drives the authorization-code flow like a browser would, minus the HTML: authorize, follow
 * the redirect to the consent page, approve (or deny) it through the consent endpoint with the
 * signed query, and return the client redirect.
 */
export async function authorizeFlow(app: Hono, options: FlowOptions): Promise<FlowResult> {
  const pair = await pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? REDIRECT_URI,
    scope: options.scope,
    state: "state-123",
    code_challenge: options.codeChallenge ?? pair.challenge,
    code_challenge_method: options.challengeMethod ?? "S256",
  });
  if (options.resource !== null) params.set("resource", options.resource ?? MCP_URL);
  const authorize = await app.request(`/api/auth/oauth2/authorize?${params}`, {
    headers: { cookie: options.cookie },
  });
  const location = authorize.headers.get("location");
  const base = { authorize, verifier: pair.verifier };
  if (!location) return { ...base, finalUrl: null, code: null };
  let url = new URL(location, ORIGIN);
  if (url.pathname === "/consent") {
    const consent = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: options.cookie, origin: ORIGIN },
      body: JSON.stringify({
        accept: options.approve ?? true,
        scope: options.acceptedScope,
        oauth_query: url.search.slice(1),
      }),
    });
    const body = (await consent.json()) as { url?: string };
    if (!body.url) return { ...base, finalUrl: null, code: null };
    url = new URL(body.url, ORIGIN);
  }
  return { ...base, finalUrl: url, code: url.searchParams.get("code") };
}

export async function tokenRequest(
  app: Hono,
  form: Record<string, string>,
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Full flow for an already registered client; throws if any step fails. */
export async function obtainTokens(
  app: Hono,
  options: FlowOptions,
): Promise<{ tokens: Tokens; flow: FlowResult }> {
  const flow = await authorizeFlow(app, options);
  if (!flow.code) {
    throw new Error(
      `authorization failed: ${flow.authorize.status} ${flow.authorize.headers.get("location")} ${flow.finalUrl}`,
    );
  }
  const { res, body } = await tokenRequest(app, {
    grant_type: "authorization_code",
    code: flow.code,
    code_verifier: flow.verifier,
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? REDIRECT_URI,
    ...(options.resource === null ? {} : { resource: options.resource ?? MCP_URL }),
  });
  if (res.status !== 200)
    throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  return { tokens: body as unknown as Tokens, flow };
}

/** Registers a throwaway MCP client and runs the whole flow for `user`; returns the tokens. */
export async function tokenFor(
  t: ApiTest,
  user: Pick<Actor, "cookie">,
  scope = "mcp:read mcp:book",
  clientId?: string,
): Promise<{ tokens: Tokens; clientId: string }> {
  const id = clientId ?? (await registerClient(t.app, { scope })).client.client_id;
  const { tokens } = await obtainTokens(t.app, { clientId: id, cookie: user.cookie, scope });
  return { tokens, clientId: id };
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads are asserted field by field in tests
export type Loose = Record<string, any>;

export interface RpcResult {
  res: Response;
  body: Loose | null;
}

/** One stateless JSON-RPC call to the MCP endpoint, the way a Streamable HTTP client sends it. */
export async function rpc(
  app: Hono,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: Loose | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { res, body };
}

export interface ToolOutcome {
  res: Response;
  /** JSON-RPC level error (unknown tool, bad params), when there is one. */
  rpcError: { code: number; message: string } | null;
  isError: boolean;
  text: string;
  data: Loose | null;
}

export async function callTool(
  app: Hono,
  token: string | null,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const { res, body } = await rpc(app, token, "tools/call", { name, arguments: args });
  const result = body?.result;
  return {
    res,
    rpcError: body?.error ?? null,
    isError: result?.isError === true,
    text: result?.content?.map((c: { text?: string }) => c.text ?? "").join("\n") ?? "",
    // Errors carry their code in `_meta`; successes in `structuredContent`.
    data: result?.isError ? (result?._meta ?? null) : (result?.structuredContent ?? null),
  };
}

export async function listTools(app: Hono, token: string): Promise<string[]> {
  const { body } = await rpc(app, token, "tools/list");
  return (body?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
}
