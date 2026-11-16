import type { ClientDuplicates } from "@sob/contracts";
import { clientProfile, type Database } from "@sob/db";
import { and, asc, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot } from "../../client-identity";

const text = (value: string | null) => value?.normalize("NFKC").trim().toLowerCase() ?? "";
const phone = (value: string | null) => value?.replace(/\D/g, "") ?? "";
/** Contact matches are suggestions only: shared family contacts never establish identity. */
export async function clientDuplicates(
  db: Database,
  id: string,
  p: Principal,
): Promise<ClientDuplicates> {
  requirePermission(p, "deleteClients");
  return db.transaction(
    async (tx) => {
      const root = await clientRoot(tx, id);
      const ids = await clientIdentityIds(tx, root.id);
      const own = await tx.select().from(clientProfile).where(inArray(clientProfile.id, ids));
      const emails = [...new Set(own.map((row) => text(row.email)).filter(Boolean))];
      const phones = [...new Set(own.map((row) => phone(row.phone)).filter(Boolean))];
      const names = [...new Set(own.map((row) => text(row.name)))];
      const matches = await tx
        .select({
          id: clientProfile.id,
          rootId: sql<string>`client_root_id(${clientProfile.id})`,
          name: clientProfile.name,
          email: clientProfile.email,
          phone: clientProfile.phone,
        })
        .from(clientProfile)
        .where(
          and(
            isNull(clientProfile.deletedAt),
            ne(sql`client_root_id(${clientProfile.id})`, root.id),
            or(
              emails.length
                ? inArray(sql<string>`lower(normalize(btrim(${clientProfile.email}),NFKC))`, emails)
                : undefined,
              phones.length
                ? inArray(
                    sql<string>`regexp_replace(${clientProfile.phone},'[^0-9]','','g')`,
                    phones,
                  )
                : undefined,
              inArray(sql<string>`lower(normalize(btrim(${clientProfile.name}),NFKC))`, names),
            ),
          ),
        )
        .orderBy(asc(clientProfile.id))
        .limit(201);
      const roots = [...new Set(matches.map((row) => row.rootId))];
      const profiles = roots.length
        ? await tx
            .select()
            .from(clientProfile)
            .where(
              and(inArray(clientProfile.id, roots.slice(0, 20)), isNull(clientProfile.deletedAt)),
            )
            .orderBy(asc(clientProfile.name), asc(clientProfile.id))
        : [];
      return {
        candidates: profiles.map((row) => {
          const sources = matches.filter((match) => match.rootId === row.id);
          const matchedBy: ClientDuplicates["candidates"][number]["matchedBy"] = [];
          if (sources.some((match) => emails.includes(text(match.email)))) matchedBy.push("email");
          if (sources.some((match) => phones.includes(phone(match.phone)))) matchedBy.push("phone");
          if (sources.some((match) => names.includes(text(match.name)))) matchedBy.push("name");
          return {
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone,
            hasAccount: Boolean(row.userId),
            matchedBy,
          };
        }),
        hasMore: roots.length > 20 || matches.length > 200,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
