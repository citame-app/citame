import { timestamp, uuid } from "drizzle-orm/pg-core";

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
