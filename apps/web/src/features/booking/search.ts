import { idSchema, instantSchema, localDateSchema } from "@sob/contracts";

/**
 * The whole booking selection lives in the URL, so every step is deep-linkable, back/forward
 * work, and signing in mid-flow loses nothing. These are the pure helpers around it.
 */
export interface BookingSearch {
  services: string[];
  /** A professional id, or `any` for "first available". */
  staff?: string;
  professionals?: string[];
  visitStaff?: string[];
  /** Salon-local date, `YYYY-MM-DD`. */
  date?: string;
  /** Start instant of the chosen slot. */
  slot?: string;
  /** The concrete professional behind the chosen slot (resolved when `staff` is `any`). */
  slotStaff?: string;
}

export type BookingStep = "services" | "professional" | "time" | "review";

const valid = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  v: unknown,
) => {
  const result = schema.safeParse(v);
  return result.success ? result.data : undefined;
};

function parseServices(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids = parts.filter((part): part is string => idSchema.safeParse(part).success);
  return [...new Set(ids)];
}

export function parseBookingSearch(raw: Record<string, unknown>): BookingSearch {
  const search: BookingSearch = { services: parseServices(raw.services) };
  const staff =
    raw.staff === "any" || raw.staff === "multiple"
      ? raw.staff
      : valid<string>(idSchema, raw.staff);
  if (staff) search.staff = staff;
  if (staff === "multiple") {
    const parseList = (value: unknown, allowAny: boolean) => {
      const values = typeof value === "string" ? value.split(",") : [];
      return values.length > 0 &&
        values.length <= 8 &&
        values.every((s) => (allowAny && s === "any") || idSchema.safeParse(s).success)
        ? values
        : undefined;
    };
    const professionals = parseList(raw.professionals, true);
    const visitStaff = parseList(raw.visitStaff, false);
    if (professionals) search.professionals = professionals;
    if (visitStaff) search.visitStaff = visitStaff;
  }
  const date = valid<string>(localDateSchema, raw.date);
  if (date) search.date = date;
  const slot = valid<string>(instantSchema, raw.slot);
  if (slot) search.slot = slot;
  const slotStaff = valid<string>(idSchema, raw.slotStaff);
  if (slotStaff) search.slotStaff = slotStaff;
  return search;
}

export function serializeBookingSearch(search: BookingSearch): Record<string, string> {
  const out: Record<string, string> = {};
  if (search.services.length > 0) out.services = search.services.join(",");
  if (search.staff) out.staff = search.staff;
  if (search.staff === "multiple" && search.professionals?.length)
    out.professionals = search.professionals.join(",");
  if (search.staff === "multiple" && search.visitStaff?.length)
    out.visitStaff = search.visitStaff.join(",");
  if (search.date) out.date = search.date;
  if (search.slot) out.slot = search.slot;
  if (search.slotStaff) out.slotStaff = search.slotStaff;
  return out;
}

/** Changing the services can change who is eligible and how long a slot is: reset the rest. */
export function toggleService(search: BookingSearch, serviceId: string): BookingSearch {
  const services = search.services.includes(serviceId)
    ? search.services.filter((id) => id !== serviceId)
    : [...search.services, serviceId];
  return { services };
}

export function firstIncompleteStep(search: BookingSearch): BookingStep {
  if (search.services.length === 0) return "services";
  if (!search.staff) return "professional";
  if (
    !search.slot ||
    !search.slotStaff ||
    (search.staff === "multiple" && !search.visitStaff?.length)
  )
    return "time";
  return "review";
}

const STEP_ORDER: BookingStep[] = ["services", "professional", "time", "review"];

/** A step is reachable when every earlier step is complete. */
export function canEnterStep(search: BookingSearch, step: BookingStep): boolean {
  return STEP_ORDER.indexOf(step) <= STEP_ORDER.indexOf(firstIncompleteStep(search));
}
