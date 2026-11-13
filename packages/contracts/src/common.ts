import { z } from "zod";

export const idSchema = z.uuid();

/** ISO 8601 instant with an explicit offset (usually `Z`). */
export const instantSchema = z.iso.datetime({ offset: true });

/** Calendar date in the salon's local timezone, `YYYY-MM-DD`. */
export const localDateSchema = z.iso.date();
