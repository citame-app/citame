import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "./helpers";

export const inventoryClassification = pgTable(
  "inventory_classification",
  {
    id: primaryId(),
    kind: text({ enum: ["category", "brand"] }).notNull(),
    parentId: uuid().references((): AnyPgColumn => inventoryClassification.id),
    name: text().notNull(),
    position: integer().notNull().default(0),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
  },
  (t) => [
    check(
      "inventory_classification_valid",
      sql`length(btrim(${t.name})) > 0 and ${t.position} >= 0 and ${t.version} > 0
          and (${t.kind} = 'category' or (${t.kind} = 'brand' and ${t.parentId} is null))
          and (${t.parentId} is null or ${t.parentId} <> ${t.id})`,
    ),
    uniqueIndex("inventory_classification_root_name")
      .on(t.kind, sql`lower(${t.name})`)
      .where(sql`${t.parentId} is null`),
    uniqueIndex("inventory_classification_child_name")
      .on(t.parentId, sql`lower(${t.name})`)
      .where(sql`${t.parentId} is not null`),
    index("inventory_classification_parent_idx").on(t.parentId),
  ],
);
