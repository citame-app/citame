import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, deletedAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { service } from "./service";

const binary = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});
export const portfolioPhoto = pgTable(
  "portfolio_photo",
  {
    id: primaryId(),
    caption: text(),
    alt: text(),
    serviceId: uuid().references(() => service.id, { onDelete: "set null" }),
    serviceName: text(),
    image: binary(),
    width: integer().notNull(),
    height: integer().notNull(),
    bytes: integer().notNull(),
    status: text().notNull().default("draft"),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    publicationVersion: text(),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("portfolio_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("portfolio_public_id_idx").on(t.status, t.id).where(sql`${t.deletedAt} is null`),
    check(
      "portfolio_photo_valid",
      sql`${t.version}>0 and ${t.status} in ('draft','published') and ${t.width} between 1 and 1024 and ${t.height} between 1 and 1024 and ${t.bytes} between 1 and 262144 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ((${t.deletedAt} is null and ${t.image} is not null and octet_length(${t.image})=${t.bytes} and ${t.caption} is not null and length(btrim(${t.caption})) between 1 and 300 and ${t.alt} is not null and length(btrim(${t.alt})) between 1 and 300) or (${t.deletedAt} is not null and ${t.image} is null and ${t.caption} is null and ${t.alt} is null and ${t.serviceId} is null and ${t.serviceName} is null and ${t.status}='draft')) and (${t.status}<>'published' or (${t.publicationVersion}='public-portfolio-v1' and ${t.publicationVersion} is not null and ${t.publishedAt} is not null))`,
    ),
  ],
);
