import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

/** Bun.SQL already encodes objects as JSON. PgJsonb's string encoder would store a JSON string. */
export const bunJsonb = <T extends object>() =>
  customType<{ data: T; driverData: T | string }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    // Accept existing encoded strings as well as PostgreSQL's decoded objects.
    fromDriver: (value) => (typeof value === "string" ? JSON.parse(value) : value),
  })();

/** UUIDv7 primary key generated in application code so clients can pre-assign ids. */
export const primaryId = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());

const timestamptz = () => timestamp({ withTimezone: true });

export const createdAt = () => timestamptz().notNull().defaultNow();

export const updatedAt = () =>
  timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Soft-delete marker; also the tombstone for the Phase 4 sync protocol. */
export const deletedAt = () => timestamptz();

export { timestamptz };
