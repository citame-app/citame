import { oauthConnectionIdSchema, parseScopes } from "@sob/contracts";
import {
  type Database,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "@sob/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../audit";
import type { AppEnv } from "../auth/principal";
import { parseOrThrow } from "../http";

function ownGrant(clientId: string, userId: string) {
  return and(
    eq(oauthConsent.clientId, clientId),
    eq(oauthConsent.userId, userId),
    isNull(oauthConsent.referenceId),
  );
}

export async function currentOAuthGrant(db: Database, clientId: string, userId: string) {
  const [row] = await db
    .select({
      id: oauthConsent.id,
      scopes: oauthConsent.scopes,
    })
    .from(oauthConsent)
    .where(ownGrant(clientId, userId))
    .orderBy(desc(oauthConsent.createdAt), desc(oauthConsent.id))
    .limit(1);
  return row;
}

export function oauthConnectionRoutes(db: Database) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/", async (c) => {
      const userId = c.get("principal").userId;
      const rows = await db
        .select({
          clientId: oauthConsent.clientId,
          name: oauthClient.name,
          scopes: oauthConsent.scopes,
          updatedAt: oauthConsent.updatedAt,
        })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(and(eq(oauthConsent.userId, userId), isNull(oauthConsent.referenceId)))
        .orderBy(desc(oauthConsent.updatedAt));
      return c.json({
        connections: [
          ...new Map(
            rows.reverse().map((row) => [
              row.clientId,
              {
                ...row,
                scopes: parseScopes(row.scopes.join(" ")),
                updatedAt: row.updatedAt.toISOString(),
              },
            ]),
          ).values(),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      });
    })
    .delete("/:clientId", async (c) => {
      const userId = c.get("principal").userId;
      const clientId = parseOrThrow(oauthConnectionIdSchema, c.req.param("clientId"));
      await db.transaction(async (tx) => {
        const revoked = await tx
          .delete(oauthConsent)
          .where(ownGrant(clientId, userId))
          .returning({ id: oauthConsent.id });
        await tx
          .delete(oauthAccessToken)
          .where(and(eq(oauthAccessToken.clientId, clientId), eq(oauthAccessToken.userId, userId)));
        await tx
          .delete(oauthRefreshToken)
          .where(
            and(eq(oauthRefreshToken.clientId, clientId), eq(oauthRefreshToken.userId, userId)),
          );
        if (revoked.length)
          await recordAudit(tx, {
            actorUserId: userId,
            action: "oauth.connection_revoked",
            entity: "oauth_client",
            entityId: clientId,
          });
      });
      return c.body(null, 204);
    });
}
