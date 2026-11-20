import { sql } from "drizzle-orm";

// Imported profiles can retain the spelling of their original tags.
export const groupName = sql<string>`lower(btrim(normalize(client_tag.name, NFKC)))`;
