import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OAUTH_SCOPES } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../app";
import type { Auth } from "../auth/auth";
import { registerTools } from "./tools";
import { BearerError, createTokenVerifier } from "./verify";

const MAX_BODY_BYTES = 64 * 1024;

const INSTRUCTIONS = [
  "Sisters of Beauty booking assistant.",
  "Typical flow: list_services -> find_availability (one day) -> create_appointment with a start time returned by find_availability.",
  "Always pass a fresh requestId (UUID) to create_appointment. Never invent ids or times.",
  "Times are ISO 8601 instants; dates for find_availability are in the salon's timezone.",
].join(" ");

/** Where the RFC 9728 document for a resource lives: well-known prefix, then the resource path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

function challenge(metadataUrl: string, error?: BearerError): string {
  const parts = [`resource_metadata="${metadataUrl}"`];
  if (error && error.code !== "invalid_request") {
    parts.push(`error="${error.code}"`, `error_description="${error.message.replace(/"/g, "'")}"`);
  }
  parts.push(`scope="${OAUTH_SCOPES.join(" ")}"`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * MCP over Streamable HTTP (spec 2025-06-18), stateless: every POST is a self-contained
 * JSON-RPC exchange answered as plain JSON, so any API replica can serve any request and there
 * is no session to hijack. There is no server-initiated traffic, hence GET (the SSE channel) and
 * DELETE (session end) answer 405 as the spec allows.
 *
 * Authentication is OAuth 2.1 bearer only. Cookies are ignored on purpose: a browser that holds a
 * session cookie must not be able to drive this endpoint from another origin.
 */
export function mcpRoutes(
  { db, config, now = () => new Date(), jwksRefetchMs }: AppDeps,
  auth: Auth,
) {
  const verifier = createTokenVerifier({ auth, db, config, keyRefetchMs: jwksRefetchMs });
  const resource = config.oauth.mcpResource;
  const metadataUrl = protectedResourceMetadataUrl(resource);

  const metadata = () => ({
    resource,
    authorization_servers: [`${config.auth.baseURL.replace(/\/+$/, "")}/api/auth`],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Sisters of Beauty booking",
  });

  const app = new Hono();

  app.all("/", async (c) => {
    let identity: Awaited<ReturnType<typeof verifier.verify>>;
    try {
      identity = await verifier.verify(c.req.header("authorization"));
      if (!identity.scopes.some((s) => s.startsWith("mcp:") || s === "schedule:read")) {
        throw new BearerError("insufficient_scope", "The token carries no MCP scope");
      }
    } catch (error) {
      if (!(error instanceof BearerError)) throw error;
      const status = error.code === "insufficient_scope" ? 403 : 401;
      return c.json({ error: error.code, error_description: error.message }, status, {
        "WWW-Authenticate": challenge(metadataUrl, error),
      });
    }

    if (c.req.method !== "POST") {
      return c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    }

    const server = new McpServer(
      { name: "sisters-of-beauty", version: "1.0.0" },
      { instructions: INSTRUCTIONS },
    );
    registerTools(server, {
      db,
      principal: identity.principal,
      scopes: identity.scopes,
      now,
      via: { channel: "mcp", clientId: identity.clientId },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token: "redacted",
          clientId: identity.clientId,
          scopes: identity.scopes,
          resource: new URL(resource),
        },
      });
    } finally {
      await server.close();
    }
  });

  return { app, metadata, metadataUrl };
}
