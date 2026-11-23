import type { OAuthScope } from "@sob/contracts";
import { recordAudit } from "../audit";
import type { ToolContext } from "./tools";

export function recordMcpWriteRequested(ctx: ToolContext, tool: string, scope: OAuthScope) {
  return recordAudit(ctx.db, {
    actorUserId: ctx.principal.userId,
    action: "mcp.write_requested",
    entity: "mcp_tool",
    metadata: { tool, oauthClientId: ctx.via.clientId, scope },
  });
}
