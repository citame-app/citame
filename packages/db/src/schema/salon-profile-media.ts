import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./helpers";

const imageBytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const salonProfileMedia = pgTable(
  "salon_profile_media",
  {
    id: uuid().primaryKey(),
    kind: text({ enum: ["logo", "cover", "gallery"] }).notNull(),
    version: uuid().notNull(),
    alt: text().notNull(),
    image: imageBytes().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    published: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("salon_profile_media_single_role")
      .on(table.kind)
      .where(sql`${table.kind} in ('logo','cover')`),
    check("salon_profile_media_kind_check", sql`${table.kind} in ('logo','cover','gallery')`),
    check("salon_profile_media_alt_check", sql`length(btrim(${table.alt})) between 1 and 160`),
    check(
      "salon_profile_media_image_check",
      sql`octet_length(${table.image}) between 1 and 262144`,
    ),
    check("salon_profile_media_width_check", sql`${table.width} between 1 and 1024`),
    check("salon_profile_media_height_check", sql`${table.height} between 1 and 1024`),
  ],
);
