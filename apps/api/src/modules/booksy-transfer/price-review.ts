import { createHash } from "node:crypto";
import { z } from "zod";
import { booksyLocalDayBounds, importedAppointmentCalendarLink } from "./local-day";
import { readBooksyPaymentEvidence } from "./payment-evidence";
import { fingerprint } from "./plan";
import {
  BOOKSY_HIDDEN_PRICE,
  type BooksySourceReadModel,
  booksyBookingLeaves,
  booksyCents,
  sourceInstant,
} from "./source-read-model";
import {
  decodeVisibleBookingObservations,
  visibleBookingEnvelope,
} from "./visible-booking-evidence";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.union([z.string(), z.number()]);
const groupDetail = z.object({
  appointment: z.object({
    appointment_uid: z.number().int().positive(),
    subbookings: z.array(z.record(z.string(), z.unknown())),
    total: money.optional(),
    total_value: money.optional(),
    total_discount_amount: money.optional(),
    payment_info: z.unknown().optional(),
  }),
});
const reviewedScreen = z.object({
  kind: z.literal("booksy-reviewed-visible-booking"),
  itemRef: z.string(),
  evidenceSha256: sha256,
  financialHold: z.object({
    displayedService: z.string(),
    discount: z.string(),
    displayedTotal: z.string(),
    displayedDue: z.string(),
  }),
});
const wrapper = z.object({
  kind: z.literal("booksy-api-response"),
  businessId: z.string(),
  source: z.url(),
  data: z.object({ body: z.string(), data: z.unknown() }),
});

function cents(value: string | number | undefined) {
  if (value === undefined) return null;
  try {
    return booksyCents(value);
  } catch {
    return null;
  }
}

const screenText = z.object({
  source: z.string(),
  ref: z.string(),
  date: z.iso.date(),
  text: z.string(),
  textSha256: sha256,
});
const screenCard = screenText.extend({ appointmentRef: z.string(), itemElementId: z.string() });
const screenDrawer = screenText.extend({ calendarRange: z.object({ start: z.string() }) });
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function validScreen(
  value: unknown,
  businessId: string,
  groupRef: string,
  startsAt: string,
  screen: z.infer<typeof reviewedScreen>,
) {
  const evidence = visibleBookingEnvelope.parse(value);
  if (evidence.businessId !== businessId) return false;
  const documents = decodeVisibleBookingObservations(evidence);
  const card = screenCard.parse(documents[0]);
  const drawer = screenDrawer.parse(documents[1]);
  if (
    card.source !== "booksy_visible_calendar_card" ||
    drawer.source !== "booksy_visible_drawer" ||
    card.appointmentRef !== groupRef ||
    card.itemElementId !== `cc-${screen.itemRef}` ||
    card.ref !== `a-${groupRef}` ||
    drawer.ref !== card.ref ||
    drawer.date !== card.date ||
    sha(card.text) !== card.textSha256 ||
    sha(drawer.text) !== drawer.textSha256 ||
    Temporal.Instant.compare(
      sourceInstant(`${drawer.date}T${drawer.calendarRange.start}`),
      startsAt,
    ) !== 0
  )
    return false;
  const lines = drawer.text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ").normalize("NFC"))
    .filter(Boolean);
  const header = lines.indexOf("RESERVA DE GRUPO");
  const discount = lines.indexOf("Descuento");
  const total = lines.indexOf("Total");
  const due = lines.indexOf("A pagar");
  const hold = screen.financialHold;
  return (
    header >= 0 &&
    discount > header &&
    total === discount + 2 &&
    due === total + 2 &&
    lines[header + 4] === hold.displayedService &&
    lines[discount + 1] === hold.discount &&
    lines[total + 1] === hold.displayedTotal &&
    lines[due + 1] === hold.displayedDue
  );
}

/** Group totals do not establish the pre-discount price of a hidden line. */
export function prepareBooksyPriceReview(model: BooksySourceReadModel) {
  const appointments = new Map(
    model.appointments.map((appointment) => [appointment.id, appointment]),
  );
  const unresolved = new Set(
    model.appointments
      .filter((appointment) => appointment.services.some((service) => service.sourceUnpriced))
      .map((appointment) => appointment.id),
  );
  if (appointments.size !== model.appointments.length)
    throw new Error("Repeated appointments in the review");
  const groups = model.groups.flatMap((group) => {
    if (!group.ids.some((id) => unresolved.has(id))) return [];
    const booked = group.ids.map((id) => {
      const appointment = appointments.get(id);
      if (
        !appointment?.sourceCopy ||
        appointment.sourceCopy.groupRef !== group.sourceId ||
        appointment.sourceCopy.businessId !== model.businessId
      )
        throw new Error("The price review cannot bind a service to its source reservation");
      if (appointment.services.some((line, position) => position > 0 && line.sourceUnpriced))
        throw new Error("No verified price hold for an add-on position");
      return { appointment, ref: appointment.sourceCopy.itemRef };
    });
    const refs = new Set(booked.map(({ ref }) => ref));
    if (refs.size !== booked.length) throw new Error("Repeated service reference in the review");

    const screen =
      group.raw.kind === "booksy-reviewed-visible-booking" ? reviewedScreen.parse(group.raw) : null;
    if (screen && (booked.length !== 1 || !refs.has(screen.itemRef)))
      throw new Error("The screen and the archived service reference differ");
    const detail = screen ? null : groupDetail.parse(group.raw).appointment;
    if (detail && String(detail.appointment_uid) !== group.sourceId)
      throw new Error("The detail and the archived reservation reference differ");

    const leaves = detail ? booksyBookingLeaves(detail.subbookings) : [];
    const sources = new Map(leaves.map((row) => [String(row.id), row]));
    if (sources.size !== leaves.length || (detail && [...refs].some((ref) => !sources.has(ref))))
      throw new Error("The archived reservation does not uniquely identify all projected services");
    for (const { appointment, ref } of booked) {
      const leaf = sources.get(ref);
      if (!leaf) {
        if (appointment.services.length !== 1)
          throw new Error("Screen requires exactly one service");
        continue;
      }
      const primary = z.string().parse(leaf.service_price);
      const extras = z
        .array(z.object({ price: money, quantity: z.number().int().positive() }))
        .parse(leaf.addons ?? []);
      const expected = [
        primary === BOOKSY_HIDDEN_PRICE ? null : booksyCents(primary),
        ...extras.map(({ price, quantity }) => booksyCents(price) * quantity),
      ];
      if (
        Temporal.Instant.compare(
          sourceInstant(z.string().parse(leaf.booked_from)),
          appointment.startsAt,
        ) !== 0 ||
        appointment.services.length !== expected.length ||
        appointment.services.some(
          (line, position) =>
            line.currency !== "EUR" ||
            (expected[position] === null
              ? !line.sourceUnpriced
              : line.sourceUnpriced || line.priceCents !== expected[position]),
        )
      )
        throw new Error("Projected pricing and source service positions differ");
    }
    const knownLinesCents = booked.reduce(
      (total, { appointment }) =>
        total +
        appointment.services.reduce(
          (sum, line) => sum + (line.sourceUnpriced ? 0 : line.priceCents),
          0,
        ),
      0,
    );
    if (!Number.isSafeInteger(knownLinesCents))
      throw new Error("Archived line sum exceeds the supported range");
    const totalCents = cents(detail?.total ?? screen?.financialHold.displayedTotal);
    const numericCents = cents(detail?.total_value);
    const discountCents = cents(detail?.total_discount_amount);
    const comparison = screen
      ? "discounted_screen"
      : booked.length !== sources.size
        ? "partial_group_projection"
        : totalCents === null || totalCents !== numericCents || discountCents !== 0
          ? "unverified_group_total"
          : totalCents === knownLinesCents
            ? "equals_visible_lines"
            : "differs_from_visible_lines";
    const lines = booked.flatMap(({ appointment, ref }) =>
      appointment.services.flatMap((service, position) => {
        if (!service.sourceUnpriced) return [];
        const label = screen?.financialHold.displayedService ?? sources.get(ref)?.service_price;
        return [
          {
            itemRef: ref,
            servicePosition: position,
            appointmentId: appointment.id,
            startsAt: appointment.startsAt,
            ...importedAppointmentCalendarLink(
              appointment.id,
              appointment.startsAt,
              model.base.timezone,
            ),
            evidence: screen
              ? "discounted_screen"
              : label === BOOKSY_HIDDEN_PRICE
                ? "hidden"
                : "needs_line_review",
          },
        ];
      }),
    );
    return [
      {
        groupRef: group.sourceId,
        groupTotalCents: totalCents,
        knownLinesCents,
        comparison,
        paymentEvidence: readBooksyPaymentEvidence(group.raw).state,
        lines,
        expectedDetail: detail ? fingerprint(detail) : null,
        screen,
        artifacts: new Set<string>(),
      },
    ];
  });
  if (
    groups.reduce((total, group) => total + group.lines.length, 0) !==
    model.appointments
      .flatMap((appointment) => appointment.services)
      .filter((line) => line.sourceUnpriced).length
  )
    throw new Error("The review does not cover every unresolved service exactly once");

  const byGroup = new Map(groups.map((group) => [group.groupRef, group]));
  if (byGroup.size !== groups.length) throw new Error("Repeated reservation in the price review");
  const byScreen = new Map(
    groups.flatMap((group) =>
      group.screen ? [[group.screen.evidenceSha256, group] as const] : [],
    ),
  );
  if (byScreen.size !== groups.filter((group) => group.screen).length)
    throw new Error("A screen was linked to more than one reservation");

  return {
    inspect(artifact: { path: string; sha256: string }, bytes: Buffer) {
      if (!artifact.path.endsWith(".json")) return;
      const json = JSON.parse(bytes.toString("utf8"));
      const screen = byScreen.get(artifact.sha256);
      if (
        screen?.screen &&
        validScreen(
          json,
          model.businessId,
          screen.groupRef,
          screen.lines[0]!.startsAt,
          screen.screen,
        )
      )
        screen.artifacts.add(artifact.sha256);
      const source = wrapper.safeParse(json);
      if (!source.success || source.data.businessId !== model.businessId) return;
      const url = new URL(source.data.source);
      const base = `https://es.booksy.com/core/v2/business_api/me/businesses/${model.businessId}/appointments/`;
      if (!url.href.startsWith(base)) return;
      const ref = /^(\d+)\/$/.exec(url.href.slice(base.length))?.[1];
      const group = ref ? byGroup.get(ref) : undefined;
      if (!group?.expectedDetail) return;
      const { body, data } = source.data.data;
      const original = JSON.parse(body);
      if (fingerprint(original) !== fingerprint(data)) return;
      const detail = groupDetail.safeParse(original);
      if (!detail.success || fingerprint(detail.data.appointment) !== group.expectedDetail) return;
      group.artifacts.add(artifact.sha256);
    },
    result() {
      const reviews = groups.map(
        ({ artifacts, expectedDetail: _detail, screen: _screen, ...group }) => {
          if (!artifacts.size)
            throw new Error("An unresolved reservation lacks its verified original");
          return { ...group, artifactSha256: [...artifacts].sort() };
        },
      );
      const pendingByDate = new Map<string, number>();
      for (const group of reviews) {
        for (const { calendarDate } of group.lines) {
          pendingByDate.set(calendarDate, (pendingByDate.get(calendarDate) ?? 0) + 1);
        }
      }
      return {
        groups: reviews,
        pendingByDate: [...pendingByDate]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, unresolvedServices]) => ({ date, unresolvedServices })),
        unresolvedServices: reviews.reduce((total, group) => total + group.lines.length, 0),
        canCutOver: false as const,
      };
    },
  };
}

type PriceReview = ReturnType<ReturnType<typeof prepareBooksyPriceReview>["result"]>;
type NativePriceReviewLine = {
  sourceBookingRef: string;
  sourceLineRef: string;
  appointmentId: string;
  servicePosition: number;
  appointmentServiceId: string;
};

/** Bind the archived holds to the exact service rows already reconciled in the candidate. */
export function bindBooksyPriceReview(
  model: BooksySourceReadModel,
  review: PriceReview,
  date: string | undefined,
  native: readonly NativePriceReviewLine[],
) {
  const bounds = date === undefined ? undefined : booksyLocalDayBounds(date, model.base.timezone);
  const appointments =
    bounds &&
    new Set(
      model.appointments
        .filter(
          ({ startsAt, endsAt }) =>
            Date.parse(startsAt) < bounds.end && Date.parse(endsAt) > bounds.start,
        )
        .map(({ id }) => id),
    );
  const key = (line: { appointmentId: string; servicePosition: number }) =>
    `${line.appointmentId}/${line.servicePosition}`;
  const positions = new Map(native.map((line) => [key(line), line]));
  if (positions.size !== native.length) throw new Error("Repeated native pricing position");
  if (new Set(native.map((line) => line.appointmentServiceId)).size !== native.length)
    throw new Error("A native service row cannot represent two archived prices");
  const groups = review.groups.flatMap((group) => {
    const lines = group.lines.flatMap((line) => {
      if (appointments && !appointments.has(line.appointmentId)) return [];
      const position = positions.get(key(line));
      if (
        !position ||
        position.sourceBookingRef !== group.groupRef ||
        position.sourceLineRef !== line.itemRef
      )
        throw new Error("Archived price hold does not match its native service");
      positions.delete(key(line));
      return [{ ...line, appointmentServiceId: position.appointmentServiceId }];
    });
    return lines.length ? [{ ...group, lines }] : [];
  });
  if (positions.size) throw new Error("Native price hold is missing from the archived review");
  return {
    ...(date === undefined
      ? {
          fromDate: model.fromDate,
          throughDate: model.throughDate,
          pendingByDate: review.pendingByDate,
        }
      : { date }),
    timezone: model.base.timezone,
    groups,
    unresolvedServices: native.length,
    canCutOver: false as const,
  };
}
