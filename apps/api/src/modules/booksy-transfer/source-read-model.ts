import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  appointmentContextSchema,
  type BooksyTransfer,
  type CalendarAppointment,
  calendarAppointmentSchema,
} from "@sob/contracts";
import { z } from "zod";
import { type CalendarSeen, projectCalendarIntervals } from "./calendar-intervals";
import { prepareObservedBooksy } from "./observed";
import { sourceUuid } from "./plan";

const record = z.record(z.string(), z.unknown());
const resourceSchema = z
  .object({ id: z.number(), name: z.string(), type: z.string() })
  .passthrough();
export const booksyBookedServiceSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string(),
});
const bookingSchema = z
  .object({
    id: z.number(),
    multibooking: z.object({ id: z.number() }),
    booked_from: z.string(),
    booked_till: z.string(),
    status: z.string(),
    resources: z.array(z.object({ id: z.number() })),
    service: booksyBookedServiceSchema.extend({ color: z.number() }).passthrough(),
    customer: z.object({ id: z.number().nullable(), name: z.string().nullable() }).passthrough(),
    paid: z.boolean(),
    is_staffer_requested_by_client: z.boolean().nullable(),
  })
  .passthrough();
const calendarSchema = z
  .object({
    start_date: z.iso.date(),
    end_date: z.iso.date(),
    resources_count: z.number(),
    resources: z.array(resourceSchema),
    bookings: z.record(z.string(), bookingSchema),
    reservations: z.record(
      z.string(),
      z.object({ reserved_from: z.string(), reserved_till: z.string() }).passthrough(),
    ),
    time_offs: z.record(z.string(), record),
  })
  .passthrough();
type CalendarCapture = { at: string; data: z.infer<typeof calendarSchema> };

function startsInCapture({ start }: CalendarSeen<unknown>, { data }: CalendarCapture) {
  const date = start.slice(0, 10);
  return date >= data.start_date && date <= data.end_date;
}

function bookingObservations({ at, data }: CalendarCapture) {
  return Object.values(data.bookings).map((row) => ({
    at,
    row,
    ref: String(row.id),
    start: row.booked_from,
    end: row.booked_till,
  }));
}

function blockObservations({ at, data }: CalendarCapture) {
  return Object.entries(data.reservations).map(([ref, row]) => ({
    at,
    row,
    ref,
    start: row.reserved_from,
    end: row.reserved_till,
  }));
}
const serviceSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    color: z.number(),
    padding_type: z.string().nullable(),
    padding_time: z.number(),
    parallel_clients: z.number(),
    resources: z.array(z.number()),
    combo_type: z.string().nullable(),
    variants: z
      .array(
        z
          .object({
            id: z.number(),
            type: z.string(),
            price: z.string(),
            duration: z.number(),
            gap_hole_start_after: z.number(),
            gap_hole_duration: z.number(),
            staffers: z.array(z.number()),
            combo_children: z.array(record),
            label: z.string().nullable(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const detailSchema = z
  .object({
    appointment: z
      .object({
        appointment_uid: z.number(),
        customer: z.object({ id: z.number().nullable().optional() }).nullable(),
        subbookings: z.array(record),
        business_secret_note: z.string().nullable(),
        business_note: z.string().nullable(),
        customer_note: z.string().nullable(),
      })
      .passthrough(),
    customer: z
      .object({
        business_customer: z
          .object({
            id: z.number(),
            full_name: z.string(),
            cell_phone: z.string().nullable(),
            email: z.string().nullable(),
            business_secret_note: z.string().nullable(),
          })
          .passthrough(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export const sourceInstant = (local: string) =>
  Temporal.PlainDateTime.from(local)
    .toZonedDateTime("Europe/Madrid", { disambiguation: "reject" })
    .toInstant()
    .toString();
/** Decimal parsing avoids floating-point money and accepts only observed EUR formats. */
export function booksyCents(value: string | number) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value)))
      throw new Error("Invalid source decimal amount");
    value = value.toFixed(2);
  }
  const s = value.replaceAll("\u00a0", " ").trim();
  const canonical = /^\d+\.\d{2}$/.test(s)
    ? s
    : /^\d[\d.]*,\d{2}\s*€$/.test(s)
      ? s.replaceAll(".", "").replace(",", ".").replace(/\s*€$/, "")
      : null;
  if (!canonical) throw new Error("Unrecognized source money format");
  const [whole, fraction] = canonical.split(".");
  const result = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid source amount");
  return result;
}
const status = (s: string): CalendarAppointment["status"] => {
  if (s === "A" || s === "P") return "booked";
  throw new Error(`Unmapped source appointment status: ${s}`);
};
export function booksyBookingLeaves(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.flatMap((row) =>
    Array.isArray(row.combo_children) && row.combo_children.length
      ? booksyBookingLeaves(row.combo_children.map((r) => record.parse(r)))
      : [row],
  );
}
export const BOOKSY_HIDDEN_PRICE = "No mostrar";

export const booksyBookedAddonsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    name: z.string(),
    price: z.union([z.string(), z.number()]),
    duration: z.number().int().nonnegative(),
    quantity: z.number().int().positive(),
  }),
);

/** Historical extras keep the booked order and amounts, even when their catalogue entry is gone. */
export function projectBookedAddons(
  businessId: string,
  addons: z.infer<typeof booksyBookedAddonsSchema>,
  catalogueRefs: ReadonlySet<string>,
) {
  return addons.map(({ id, name, duration, price, quantity }) => {
    const ref = `addon:${id}`;
    const durationMinutes = duration * quantity;
    const priceCents = booksyCents(price) * quantity;
    if (!Number.isSafeInteger(durationMinutes) || !Number.isSafeInteger(priceCents))
      throw new Error("Booked add-on amount exceeds the supported range");
    return {
      serviceId: catalogueRefs.has(ref) ? sourceUuid(businessId, "services", ref) : null,
      name: quantity === 1 ? name : `${name} × ${quantity}`,
      durationMinutes,
      bufferMinutes: 0,
      priceCents,
      currency: "EUR",
    };
  });
}

export interface BooksySourceReadModel {
  version: 1;
  businessId: string;
  fromDate: string;
  throughDate: string;
  capturedAt: string;
  lastAppointmentProven: false;
  lastObservedAppointmentAt: string | null;
  base: BooksyTransfer;
  appointments: CalendarAppointment[];
  contexts: Record<
    string,
    z.infer<typeof appointmentContextSchema> & { businessMessage: string | null }
  >;
  groups: { sourceId: string; ids: string[]; raw: Record<string, unknown> }[];
  inventory: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  businessName: string;
  summary: {
    groups: number;
    bookedServices: number;
    clients: number;
    services: number;
    staff: number;
    blocks: number;
    directoryClients: number;
    addons: number;
    products: number;
    resources: number;
  };
}

/** Complete source rows form an immutable consultation copy, including original overlaps.
 * No appointment is inserted into the operational scheduler and no capacity policy is relaxed. */
export async function prepareBooksySourceReadModel(
  root: string,
  businessId: string,
  fromDate: string,
): Promise<BooksySourceReadModel> {
  const { input: base } = await prepareObservedBooksy(root, businessId, fromDate);
  const calendars = new Map<string, CalendarCapture>();
  const dailyCalendars = new Map<string, CalendarCapture>();
  const calendarHistory: CalendarCapture[] = [];
  const details = new Map<number, { at: string; data: z.infer<typeof detailSchema> }>();
  let catalog: {
    at: string;
    categories: { name: string; services: z.infer<typeof serviceSchema>[] }[];
  } | null = null;
  const fullResources = new Map<number, z.infer<typeof resourceSchema>>();
  let inventory: { at: string; rows: Record<string, unknown>[] } | null = null;
  let businessName = "Citame · Copia de Booksy";
  const sourceColors = new Map<string, { at: string; color: string }>();
  let sourceCapturedAt = "";
  let addons: { at: string; rows: Record<string, unknown>[] } | null = null;
  const directoryPages = new Map<
    number,
    { at: string; count: number; perPage: number; customers: Record<string, unknown>[] }
  >();
  for (const artifact of base.artifacts) {
    const file = artifact.path;
    const bytes = await readFile(`${root}/${file}`);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
      throw new Error("Source response checksum mismatch");
    const original = JSON.parse(bytes.toString("utf8"));
    if (original.kind === "booksy-master-services" && original.businessId === businessId) {
      const master = z
        .object({
          capturedAt: z.string(),
          rows: z.array(z.object({ sourceId: z.string(), color: z.string() })),
        })
        .parse(original);
      for (const row of master.rows) {
        const components = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(row.color);
        if (!components) throw new Error("Source service colour is unverified");
        const color = `#${components
          .slice(1)
          .map((v) => Number(v).toString(16).padStart(2, "0"))
          .join("")}`;
        const old = sourceColors.get(row.sourceId);
        if (!old || master.capturedAt > old.at)
          sourceColors.set(row.sourceId, { at: master.capturedAt, color });
      }
      continue;
    }
    const wrapper = z
      .object({
        kind: z.literal("booksy-api-response"),
        businessId: z.string(),
        capturedAt: z.string(),
        source: z.url(),
        data: z.object({ body: z.string(), data: record }).passthrough(),
      })
      .safeParse(original);
    if (!wrapper.success) continue;
    const d = wrapper.data;
    if (d.capturedAt > sourceCapturedAt) sourceCapturedAt = d.capturedAt;
    if (d.businessId !== businessId) throw new Error("Source business differs");
    const url = new URL(d.source);
    const prefix = `/core/v2/business_api/me/businesses/${businessId}/`;
    if (
      url.origin !== "https://es.booksy.com" ||
      (!url.pathname.startsWith(prefix) && url.pathname !== prefix.slice(0, -1))
    )
      throw new Error("Unverified source origin");
    const payload = JSON.parse(d.data.body);
    if (JSON.stringify(payload) !== JSON.stringify(d.data.data))
      throw new Error("Retained source response differs from parsed data");
    if (url.pathname.endsWith("/calendar")) {
      const c = calendarSchema.parse(payload);
      if (c.resources.length !== c.resources_count)
        throw new Error("Calendar resource pages are incomplete");
      calendarHistory.push({ at: d.capturedAt, data: c });
      const target = c.start_date === c.end_date ? dailyCalendars : calendars;
      const previous = target.get(c.start_date);
      if (!previous || Temporal.Instant.compare(d.capturedAt, previous.at) > 0)
        target.set(c.start_date, { at: d.capturedAt, data: c });
    } else if (/\/appointments\/\d+\/$/.test(url.pathname)) {
      const a = detailSchema.parse(payload);
      if (!url.pathname.endsWith(`/appointments/${a.appointment.appointment_uid}/`))
        throw new Error("Source reservation identity differs");
      const previous = details.get(a.appointment.appointment_uid);
      if (!previous || d.capturedAt > previous.at)
        details.set(a.appointment.appointment_uid, { at: d.capturedAt, data: a });
    } else if (url.pathname.endsWith("/service_categories")) {
      const categories = z
        .object({
          service_categories: z.array(
            z.object({ name: z.string(), services: z.array(serviceSchema) }),
          ),
        })
        .parse(payload).service_categories;
      if (!catalog || d.capturedAt > catalog.at) catalog = { at: d.capturedAt, categories };
    } else if (url.pathname.endsWith("/resources")) {
      const rs = z
        .object({ resources: z.array(resourceSchema), resources_count: z.number() })
        .parse(payload);
      if (rs.resources.length !== rs.resources_count)
        throw new Error("Resource list is incomplete");
      for (const r of rs.resources) fullResources.set(r.id, r);
    } else if (
      url.pathname.endsWith("/customers") &&
      url.searchParams.get("compact") === "false" &&
      url.searchParams.get("per_page") === "100"
    ) {
      const page = z
        .object({
          page: z.number(),
          per_page: z.number(),
          count: z.number(),
          customers: z.array(record),
          import_in_progress: z.boolean(),
        })
        .parse(payload);
      if (page.import_in_progress)
        throw new Error("Source client directory is being imported; wait for a consistent copy");
      const old = directoryPages.get(page.page);
      if (!old || d.capturedAt > old.at)
        directoryPages.set(page.page, {
          at: d.capturedAt,
          count: page.count,
          perPage: page.per_page,
          customers: page.customers,
        });
    } else if (
      url.pathname.endsWith("/services/addons") &&
      url.searchParams.get("per_page") === "100"
    ) {
      const page = z
        .object({ count: z.number(), page: z.number(), data: z.array(record) })
        .parse(payload);
      if (page.page !== 1 || page.data.length !== page.count)
        throw new Error("Source extras collection is incomplete");
      if (!addons || d.capturedAt > addons.at) addons = { at: d.capturedAt, rows: page.data };
    } else if (
      url.pathname.endsWith("/warehouse/commodities") &&
      url.searchParams.get("per_page") === "100"
    ) {
      const page = z
        .object({ counter: z.number(), page: z.number(), commodities: z.array(record) })
        .parse(payload);
      if (page.page !== 1 || page.counter !== page.commodities.length)
        throw new Error("Source inventory is incomplete");
      if (!inventory || d.capturedAt > inventory.at)
        inventory = { at: d.capturedAt, rows: page.commodities };
    } else if (url.pathname === prefix.slice(0, -1)) {
      const business = z.object({ business: record }).parse(payload).business;
      if (typeof business.name === "string" && business.name) businessName = business.name;
    }
  }
  if (!catalog || !calendars.has(fromDate))
    throw new Error("Full catalog or initial calendar interval is missing");
  const id = (kind: string, ref: string | number) => sourceUuid(businessId, kind, String(ref));
  const sourceStaff = new Set(
    [...fullResources.values()].filter((r) => r.type === "S").map((r) => r.id),
  );
  if (!sourceStaff.size) throw new Error("Source staff list is missing");
  base.staff = base.staff.map((s) => ({
    ...s,
    maxConcurrent: null,
    raw: { ...s.raw, sourceProfile: fullResources.get(Number(s.sourceId)) },
  }));
  if (
    base.staff.length !== sourceStaff.size ||
    base.staff.some((s) => !sourceStaff.has(Number(s.sourceId)))
  )
    throw new Error("Staff identifiers do not reconcile");
  base.services = [];
  base.assignments = [];
  base.clients = [];
  base.appointments = [];
  base.timeOff = [];
  base.unprojected = [];
  const palette = new Map<number, string>();
  for (const c of catalog.categories)
    for (const s of c.services) {
      const color = sourceColors.get(String(s.id))?.color;
      if (!color) throw new Error("Source catalog colour mapping is incomplete");
      const previous = palette.get(s.color);
      if (previous && previous !== color)
        throw new Error("Source palette changed between captures; read fresh colour evidence");
      palette.set(s.color, color);
    }
  if (!addons) throw new Error("Full source extras collection is missing");
  for (const category of catalog.categories)
    for (const s of category.services) {
      if (s.variants.length !== 1 || s.variants[0]!.type !== "X" || s.parallel_clients !== 1)
        throw new Error("Unsupported source catalog mode requires a verified adapter");
      const v = s.variants[0]!;
      if (v.gap_hole_duration || v.gap_hole_start_after)
        base.unprojected.push({ kind: "catalog_processing_terms", sourceId: String(s.id), raw: s });
      if (s.padding_time && s.padding_type !== "A")
        throw new Error("Unsupported pre-service padding");
      base.services.push({
        sourceId: String(s.id),
        name: s.name,
        description: s.description || null,
        category: category.name || null,
        color: sourceColors.get(String(s.id))!.color,
        durationMinutes: v.duration,
        bufferMinutes: s.padding_time,
        priceCents: booksyCents(v.price),
        currency: "EUR",
        active: !s.combo_type,
        raw: s,
      });
      for (const staff of v.staffers) {
        if (!sourceStaff.has(staff)) throw new Error("Catalog references missing staff");
        base.assignments.push({ staffRef: String(staff), serviceRef: String(s.id) });
      }
      if (s.combo_type)
        base.unprojected.push({
          kind: "combo_operational_mapping",
          sourceId: String(s.id),
          raw: s,
        });
      if (s.resources.some((r) => !sourceStaff.has(r)))
        base.unprojected.push({
          kind: "alternate_service_resources",
          sourceId: String(s.id),
          raw: s,
        });
    }
  const baseServiceRefs = new Set(base.services.map(({ sourceId }) => sourceId));
  for (const source of addons.rows) {
    const a = z
      .object({
        id: z.number(),
        name: z.string(),
        price: z.union([z.string(), z.number()]).nullable(),
        price_type: z.string(),
        duration: z.number(),
        services: z.array(z.number().int().positive()),
        is_available_for_customer_booking: z.boolean(),
        max_allowed_quantity: z.number().int().positive(),
      })
      .parse(source);
    if (a.price === null) {
      base.unprojected.push({
        kind: "source_variable_price_addon",
        sourceId: String(a.id),
        raw: source,
      });
      continue;
    }
    const parentRefs = a.services.map(String);
    if (
      new Set(parentRefs).size !== parentRefs.length ||
      parentRefs.some((ref) => !baseServiceRefs.has(ref))
    )
      throw new Error("Source add-on eligibility references an unknown or repeated base service");
    const addonRef = `addon:${a.id}`;
    const active =
      a.price_type === "X" && a.is_available_for_customer_booking && parentRefs.length > 0;
    base.services.push({
      sourceId: addonRef,
      name: a.name,
      description: null,
      category: null,
      color: null,
      durationMinutes: a.duration,
      bufferMinutes: 0,
      priceCents: booksyCents(a.price),
      currency: "EUR",
      active,
      catalogKind: "addon",
      ...(parentRefs.length ? { addonParentRefs: parentRefs } : {}),
      raw: source,
    });
    const staffRefs = new Set(
      base.assignments
        .filter(({ serviceRef }) => parentRefs.includes(serviceRef))
        .map(({ staffRef }) => staffRef),
    );
    for (const staffRef of staffRefs) base.assignments.push({ staffRef, serviceRef: addonRef });
    if (!parentRefs.length || !a.is_available_for_customer_booking || a.max_allowed_quantity !== 1)
      base.unprojected.push({
        kind: !parentRefs.length
          ? "addon_eligibility_configuration"
          : a.is_available_for_customer_booking
            ? "addon_quantity_rules"
            : "addon_staff_only_booking",
        sourceId: String(a.id),
        raw: source,
      });
  }
  // Use one aligned weekly snapshot per range. Overlapping older observations must not
  // resurrect a line absent from the final copy; earlier originals remain in the vault.
  const sorted = [...calendars.values()]
    .filter((c) => {
      const days = Temporal.PlainDate.from(fromDate).until(c.data.start_date).days;
      return days >= 0 && days % 7 === 0;
    })
    .sort((a, b) => a.data.start_date.localeCompare(b.data.start_date));
  const covered = new Set<string>();
  const selectedBookings: ReturnType<typeof bookingObservations> = [];
  const selectedBlocks: ReturnType<typeof blockObservations> = [];
  const hasFullResourceScope = (data: z.infer<typeof calendarSchema>) =>
    data.resources_count === fullResources.size &&
    new Set(data.resources.map((row) => row.id)).size === fullResources.size &&
    data.resources.every((row) => fullResources.has(row.id));
  for (const c of sorted) {
    if (!hasFullResourceScope(c.data))
      throw new Error("Weekly refresh does not include the full resource list");
    for (
      let day = Temporal.PlainDate.from(c.data.start_date);
      Temporal.PlainDate.compare(day, c.data.end_date) <= 0;
      day = day.add({ days: 1 })
    )
      covered.add(day.toString());
    const useWeekly = (row: CalendarSeen<unknown>) => {
      const date = row.start.slice(0, 10);
      const daily = dailyCalendars.get(date);
      return startsInCapture(row, c) && (!daily || Temporal.Instant.compare(daily.at, c.at) <= 0);
    };
    selectedBookings.push(...bookingObservations(c).filter(useWeekly));
    selectedBlocks.push(...blockObservations(c).filter(useWeekly));
    for (const [key, row] of Object.entries(c.data.time_offs))
      base.unprojected.push({ kind: "source_time_off", sourceId: key, raw: row });
  }
  for (const [day, daily] of dailyCalendars) {
    const week = sorted.find((c) => c.data.start_date <= day && c.data.end_date >= day);
    if (!week || Temporal.Instant.compare(daily.at, week.at) <= 0) continue;
    if (!hasFullResourceScope(daily.data))
      throw new Error("Daily refresh does not include the full resource list");
    const startsOnDay = ({ start }: CalendarSeen<unknown>) => start.slice(0, 10) === day;
    selectedBookings.push(...bookingObservations(daily).filter(startsOnDay));
    selectedBlocks.push(...blockObservations(daily).filter(startsOnDay));
    for (const [key, row] of Object.entries(daily.data.time_offs))
      base.unprojected.push({ kind: "source_time_off", sourceId: key, raw: row });
  }
  const throughDate = sorted
    .map((c) => c.data.end_date)
    .sort()
    .at(-1)!;
  for (
    let day = Temporal.PlainDate.from(fromDate);
    Temporal.PlainDate.compare(day, throughDate) <= 0;
    day = day.add({ days: 1 })
  )
    if (!covered.has(day.toString())) throw new Error(`Calendar interval missing: ${day}`);
  const eligibleHistory = calendarHistory.filter(({ data }) => {
    const { start_date: start, end_date: end } = data;
    const days = Temporal.PlainDate.from(fromDate).until(start).days;
    return (start === end || (days >= 0 && days % 7 === 0)) && hasFullResourceScope(data);
  });
  const insideCapture = (row: CalendarSeen<unknown>, capture: CalendarCapture) =>
    covered.has(row.start.slice(0, 10)) && startsInCapture(row, capture);
  const bookings = projectCalendarIntervals(
    selectedBookings,
    eligibleHistory.flatMap((capture) =>
      bookingObservations(capture).filter((row) => insideCapture(row, capture)),
    ),
  );
  const blocks = projectCalendarIntervals(
    selectedBlocks,
    eligibleHistory.flatMap((capture) =>
      blockObservations(capture).filter((row) => insideCapture(row, capture)),
    ),
  );
  const capturedAt = sourceCapturedAt;
  base.capturedAt = capturedAt;
  const appointments: CalendarAppointment[] = [];
  const contexts: BooksySourceReadModel["contexts"] = {};
  const groupRows = new Map<number, BooksySourceReadModel["groups"][number]>();
  const clients = new Map<string, BooksyTransfer["clients"][number]>();
  const directoryCount = directoryPages.get(1)?.count;
  if (directoryCount === undefined) throw new Error("Complete client directory is missing");
  for (let page = 1; page <= Math.ceil(directoryCount / 100); page++) {
    const source = directoryPages.get(page);
    if (!source || source.count !== directoryCount || source.perPage !== 100)
      throw new Error(`Client directory page missing or inconsistent: ${page}`);
    for (const row of source.customers) {
      const customer = z
        .object({
          business_customer: z
            .object({
              id: z.number(),
              full_name: z.string(),
              cell_phone: z.string().nullable(),
              email: z.string().nullable(),
              business_secret_note: z.string().nullable(),
            })
            .passthrough(),
        })
        .parse(row).business_customer;
      const c: Record<string, unknown> = customer;
      const contactDetails: Record<string, unknown> = {};
      for (const [target, source] of [
        ["firstName", "first_name"],
        ["lastName", "last_name"],
        ["taxId", "tax_id"],
      ] as const)
        if (typeof c[source] === "string" && c[source]) contactDetails[target] = c[source];
      const address = [c.address_line_1, c.address_line_2, c.city, c.zipcode]
        .filter((v) => typeof v === "string" && v)
        .join("\n");
      if (address) contactDetails.address = address;
      if (typeof c.birthday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.birthday)) {
        const b = Temporal.PlainDate.from(c.birthday);
        contactDetails.birthday = {
          month: b.month,
          day: b.day,
          year: c.short_birthday ? null : b.year,
        };
      }
      if (
        typeof c.discount === "number" &&
        c.discount >= 0 &&
        c.discount <= 100 &&
        Number.isInteger(c.discount * 100)
      )
        contactDetails.discountBasisPoints = c.discount * 100;
      const tags = Array.isArray(c.tags)
        ? c.tags
            .map((t) =>
              typeof t === "string"
                ? t
                : typeof t === "object" && t && "name" in t && typeof t.name === "string"
                  ? t.name
                  : null,
            )
            .filter((t): t is string => Boolean(t))
        : [];
      const allergies =
        typeof c.allergens === "string" && c.allergens ? `Alergias (Booksy): ${c.allergens}` : null;
      clients.set(String(customer.id), {
        sourceId: String(customer.id),
        name: customer.full_name || "Sin nombre en Booksy",
        phone: customer.cell_phone,
        email: customer.email,
        notes: [customer.business_secret_note, allergies].filter(Boolean).join("\n\n") || null,
        contactDetails,
        ...(tags.length <= 20 ? { tags: [...new Set(tags)] } : {}),
        bookingAccess:
          c.blacklisted === true ? "blocked" : c.trusted === true ? "trusted" : "normal",
        raw: row,
      });
    }
  }
  if (clients.size !== directoryCount)
    throw new Error("Client directory identifiers do not reconcile with source total");
  const catalogueRefs = new Set(base.services.map(({ sourceId }) => sourceId));
  for (const { row: b } of bookings.values()) {
    const detail = details.get(b.multibooking.id)?.data;
    if (!detail) throw new Error(`Reservation detail missing: ${b.multibooking.id}`);
    const a = detail.appointment;
    const customer = detail.customer?.business_customer;
    if ((a.customer?.id ?? null) !== b.customer.id || (customer?.id ?? null) !== b.customer.id)
      throw new Error("Source client identity differs");
    const clientRef = customer ? String(customer.id) : `walk-in:${b.multibooking.id}`;
    const clientName = customer?.full_name ?? "Cliente sin cita previa";
    const sub = booksyBookingLeaves(a.subbookings).find((s) => s.id === b.id);
    if (!sub || sub.booked_from !== b.booked_from || sub.booked_till !== b.booked_till)
      throw new Error(`Booked service changed during capture: ${b.id}`);
    const detailedService = booksyBookedServiceSchema.parse(sub.service);
    if (detailedService.id !== b.service.id || detailedService.name !== b.service.name)
      throw new Error("Booked treatment differs between the calendar and reservation detail");
    const requested = z.boolean().nullable().parse(sub.is_staffer_requested_by_client);
    if ((requested === true) !== (b.is_staffer_requested_by_client === true))
      throw new Error("Booked staff preference differs between the calendar and reservation detail");
    const staff = b.resources.filter((r) => sourceStaff.has(r.id));
    if (staff.length !== 1 || sub.staffer_id !== staff[0]!.id)
      throw new Error("Booked professional is ambiguous");
    const startsAt = sourceInstant(b.booked_from),
      endsAt = sourceInstant(b.booked_till);
    const durationMinutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60000;
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
      throw new Error("Invalid frozen booking interval");
    const ownId = id("sourceAppointments", b.id);
    const mainPrice = z.string().parse(sub.service_price);
    const serviceSnapshot = {
      serviceId: b.service.id === undefined ? null : id("services", b.service.id),
      name: b.service.name,
      durationMinutes,
      bufferMinutes: 0,
      priceCents: mainPrice === BOOKSY_HIDDEN_PRICE ? 0 : booksyCents(mainPrice),
      ...(mainPrice === BOOKSY_HIDDEN_PRICE
        ? { sourceUnpriced: true as const, priceDisplayLabel: mainPrice }
        : {}),
      currency: "EUR",
    };
    const snapshots = [
      serviceSnapshot,
      ...projectBookedAddons(businessId, booksyBookedAddonsSchema.parse(sub.addons), catalogueRefs),
    ];
    const internalNote = a.business_secret_note || null;
    const customerComment = a.customer_note || null;
    const badge = {
      servicePosition: 0,
      requested: b.is_staffer_requested_by_client === true,
      invoiced: false,
      paid: b.paid,
      billingSource: b.paid ? ("booksy" as const) : null,
      internalNote: Boolean(internalNote),
      customerComment: Boolean(customerComment),
    };
    const resources = b.resources
      .filter((r) => !sourceStaff.has(r.id))
      .map((r) => ({ name: fullResources.get(r.id)?.name ?? String(r.id), quantity: 1 }));
    const projected = calendarAppointmentSchema.parse({
      id: ownId,
      staffId: id("staff", staff[0]!.id),
      clientId: id("clients", clientRef),
      startsAt,
      endsAt,
      status: status(b.status),
      notes: null,
      version: 1,
      services: snapshots,
      createdAt: capturedAt,
      updatedAt: capturedAt,
      clientName,
      serviceNames: snapshots.map((s) => s.name),
      serviceColors:
        b.service.id === undefined
          ? {}
          : {
              [id("services", b.service.id)]:
                sourceColors.get(String(b.service.id))?.color ??
                palette.get(b.service.color) ??
                "#a8b8ad",
            },
      serviceBadges: snapshots.map((_, servicePosition) => ({ ...badge, servicePosition })),
      resources,
      sourceCopy: {
        system: "booksy",
        businessId,
        groupRef: String(b.multibooking.id),
        itemRef: String(b.id),
        capturedAt,
        readOnly: true,
      },
    });
    appointments.push(projected);
    contexts[ownId] = {
      ...appointmentContextSchema.parse({
        customerComment,
        rows: snapshots.map((_, servicePosition) => ({
          servicePosition,
          requestedStaffId: badge.requested ? projected.staffId : null,
          internalNote,
          customerComment: null,
          invoiced: null,
          paid: b.paid,
          version: 1,
          source: "booksy",
          sourceRef: `${businessId}:${b.id}:${servicePosition}`,
        })),
      }),
      businessMessage: a.business_note || null,
    };
    const group = groupRows.get(b.multibooking.id) ?? {
      sourceId: String(b.multibooking.id),
      ids: [],
      raw: detail,
    };
    group.ids.push(ownId);
    groupRows.set(b.multibooking.id, group);
    if (!clients.has(clientRef))
      clients.set(clientRef, {
        sourceId: clientRef,
        name: clientName,
        phone: customer?.cell_phone ?? null,
        email: customer?.email ?? null,
        notes: customer?.business_secret_note || null,
        raw: customer ?? {
          sourceCustomerId: null,
          reservationRef: String(b.multibooking.id),
          anonymousWalkIn: true,
        },
      });
  }
  base.clients = [...clients.values()];
  for (const [sourceId, { row: b, start, end }] of blocks) {
    const startsAt = sourceInstant(start),
      endsAt = sourceInstant(end);
    const resources = z.array(z.object({ id: z.number() })).parse(b.resources);
    for (const r of resources.filter((r) => sourceStaff.has(r.id)))
      base.timeOff.push({
        sourceId: `${sourceId}:${r.id}`,
        staffRef: String(r.id),
        startsAt,
        endsAt,
        reason:
          typeof b.reason === "string"
            ? b.reason
            : typeof b.business_note === "string"
              ? b.business_note
              : null,
        raw: b,
      });
    base.unprojected.push({ kind: "source_block_original", sourceId, raw: b });
  }
  base.horizon = {
    lastAppointmentAt: null,
    lastAppointmentProven: false,
    evidence: [
      `Source calendar covered ${fromDate} through ${throughDate}; no unbounded last-reservation proof`,
    ],
  };
  base.unprojected.push({
    kind: "consultation_appointments",
    sourceId: businessId,
    raw: {
      groups: groupRows.size,
      bookedServices: appointments.length,
      reason:
        "Original overlaps and cross-professional groups are retained without relaxing operational scheduling constraints",
    },
  });
  for (const key of ["appointments", "services", "clients", "staff", "hours", "timeOff"] as const)
    base.coverage[key] = {
      state: "partial",
      expected: null,
      evidence: ["Verified source consultation copy; operational cutover remains separate"],
    };
  return {
    version: 1,
    businessId,
    fromDate,
    throughDate,
    capturedAt,
    lastAppointmentProven: false,
    lastObservedAppointmentAt:
      appointments
        .map((a) => a.startsAt)
        .sort()
        .at(-1) ?? null,
    base,
    appointments,
    contexts,
    groups: [...groupRows.values()],
    inventory: inventory?.rows ?? [],
    resources: [...fullResources.values()].filter((r) => r.type === "R"),
    businessName,
    summary: {
      groups: groupRows.size,
      bookedServices: appointments.length,
      clients: clients.size,
      services: catalog.categories.reduce((n, c) => n + c.services.length, 0),
      staff: base.staff.length,
      blocks: blocks.size,
      directoryClients: directoryCount,
      addons: addons.rows.length,
      products: inventory?.rows.length ?? 0,
      resources: [...fullResources.values()].filter((r) => r.type === "R").length,
    },
  };
}
