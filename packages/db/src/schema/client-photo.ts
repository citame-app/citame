import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, deletedAt, primaryId, updatedAt } from "./helpers";

const binary = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
export const clientPhoto = pgTable(
  "client_photo",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id, { onDelete: "cascade" }),
    caption: text().notNull(),
    capturedOn: date(),
    image: binary(),
    width: integer().notNull(),
    height: integer().notNull(),
    bytes: integer().notNull(),
    permissionVersion: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("client_photo_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("client_photo_active_client_idx")
      .on(t.clientId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    check(
      "client_photo_valid",
      sql`${t.width} between 1 and 1024 and ${t.height} between 1 and 1024 and ${t.bytes} between 1 and 262144 and ${t.version}>0 and length(btrim(${t.caption})) between 1 and 300 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ((${t.deletedAt} is null and ${t.image} is not null and octet_length(${t.image})=${t.bytes}) or (${t.deletedAt} is not null and ${t.image} is null))`,
    ),
  ],
);
