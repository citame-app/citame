import type { BooksyTransfer } from "@sob/contracts";
import { z } from "zod";
import { type BooksySourceReadModel, booksyCents } from "./source-read-model";

type Service = BooksyTransfer["services"][number];
const sourceMoney = z.union([z.string(), z.number()]);
const variant = z.object({
  id: z.number().int().positive(),
  price: sourceMoney,
  duration: z.number().int().nonnegative(),
  staffers: z.array(z.number().int().positive()),
  gap_hole_duration: z.number().int().nonnegative().optional(),
  gap_hole_start_after: z.number().int().nonnegative().optional(),
});
const combo = variant.extend({
  combo_children: z
    .array(z.object({ service_variant: z.object({ id: variant.shape.id }), price: sourceMoney }))
    .min(2),
});

function combinationType(service: Service) {
  const type = service.raw.combo_type;
  return typeof type === "string" && type.length > 0 ? type : null;
}

/** Preserve source IDs and frozen booking references, while preventing standalone booking. */
export function holdBooksyCombinations(services: Service[]): Service[] {
  return services.map((service) =>
    combinationType(service) && service.active ? { ...service, active: false } : service,
  );
}

type ComponentTerms = {
  serviceRef: string;
  priceCents: number;
  cataloguePriceCents: number;
  durationMinutes: number;
  bufferMinutes: number;
};

type SourceTerms = {
  type: string;
  currency: Service["currency"];
  totalCents: number;
  durationMinutes: number;
  bufferMinutes: number;
  staffRefs: string[];
  commonStaffRefs: string[];
  components: ComponentTerms[];
};

type TermsIssue =
  | "invalid_variant"
  | "unresolved_component"
  | "invalid_amount"
  | "component_price_mismatch"
  | "projection_mismatch"
  | "unsupported_processing";

type TermsResult = { terms: SourceTerms | null; issue: TermsIssue | null };

type SourceVariant = { service: Service; variant: z.infer<typeof variant>; staff: Set<number> };

function projectionMatches(service: Service, source: z.infer<typeof variant>, priceCents: number) {
  return (
    service.priceCents === priceCents &&
    service.durationMinutes === source.duration &&
    (service.raw.padding_time === undefined || service.raw.padding_time === service.bufferMinutes)
  );
}

function requiresProcessing(source: z.infer<typeof variant>) {
  return Boolean(source.gap_hole_duration || source.gap_hole_start_after);
}

function resolveTerms(
  service: Service,
  type: string,
  originals: ReadonlyMap<number, SourceVariant | null>,
): TermsResult {
  const parsed = z.tuple([combo]).safeParse(service.raw.variants);
  if (!parsed.success) return { terms: null, issue: "invalid_variant" };
  const [terms] = parsed.data;
  const components: ComponentTerms[] = [];
  const assignments: Set<number>[] = [];
  let totalCents: number;
  try {
    totalCents = booksyCents(terms.price);
    if (requiresProcessing(terms)) return { terms: null, issue: "unsupported_processing" };
    if (!projectionMatches(service, terms, totalCents))
      return { terms: null, issue: "projection_mismatch" };
    for (const child of terms.combo_children) {
      const component = originals.get(child.service_variant.id);
      if (!component) return { terms: null, issue: "unresolved_component" };
      if (requiresProcessing(component.variant))
        return { terms: null, issue: "unsupported_processing" };
      if (
        component.service.currency !== service.currency ||
        !projectionMatches(
          component.service,
          component.variant,
          booksyCents(component.variant.price),
        )
      )
        return { terms: null, issue: "projection_mismatch" };
      components.push({
        serviceRef: component.service.sourceId,
        priceCents: booksyCents(child.price),
        cataloguePriceCents: component.service.priceCents,
        durationMinutes: component.service.durationMinutes,
        bufferMinutes: component.service.bufferMinutes,
      });
      assignments.push(component.staff);
    }
  } catch {
    return { terms: null, issue: "invalid_amount" };
  }
  const componentTotal = components.reduce((sum, row) => sum + row.priceCents, 0);
  const issue =
    !Number.isSafeInteger(componentTotal) || componentTotal !== totalCents
      ? "component_price_mismatch"
      : null;
  const commonStaff = [...(assignments[0] ?? [])].filter((staff) =>
    assignments.every((assigned) => assigned.has(staff)),
  );
  return {
    terms: {
      type,
      currency: service.currency,
      totalCents,
      durationMinutes: terms.duration,
      bufferMinutes: service.bufferMinutes,
      staffRefs: [...new Set(terms.staffers)].map(String),
      commonStaffRefs: commonStaff.map(String),
      components,
    },
    issue,
  };
}

function readCombinations(services: readonly Service[]) {
  const originals = new Map<number, SourceVariant | null>();
  for (const service of services) {
    if (combinationType(service)) continue;
    const parsed = z.array(variant).safeParse(service.raw.variants);
    if (!parsed.success) continue;
    for (const row of parsed.data) {
      originals.set(
        row.id,
        originals.has(row.id) ? null : { service, variant: row, staff: new Set(row.staffers) },
      );
    }
  }
  return services.flatMap((service) => {
    const type = combinationType(service);
    if (!type) return [];
    return [
      {
        sourceId: service.sourceId,
        active: service.active,
        publiclyAvailable: service.raw.is_available_for_customer_booking === true,
        ...resolveTerms(service, type, originals),
      },
    ];
  });
}

/** Resolve ordered, discounted source terms without marking the archived service bookable. */
export function sourceBooksyCombinationTerms(services: readonly Service[]) {
  return readCombinations(services).map((row) => ({
    ...row,
    terms: row.issue ? null : row.terms,
  }));
}

/** Aggregate differences from Citame's current catalogue-priced, same-professional shortcuts. */
export function reviewBooksyCombinations(services: readonly Service[]) {
  const counts = {
    captured: 0,
    held: 0,
    publiclyOfferedAtSource: 0,
    discountedVersusCatalogue: 0,
    differentQualifiedStaff: 0,
    differentDuration: 0,
    componentPriceMismatch: 0,
    unverifiedTerms: 0,
  };
  for (const { active, publiclyAvailable, terms, issue } of readCombinations(services)) {
    counts.captured++;
    counts.held += Number(!active);
    counts.publiclyOfferedAtSource += Number(publiclyAvailable);
    counts.componentPriceMismatch += Number(issue === "component_price_mismatch");
    if (!terms) {
      counts.unverifiedTerms++;
      continue;
    }
    const catalogueTotal = terms.components.reduce((sum, row) => sum + row.cataloguePriceCents, 0);
    const duration = terms.components.reduce(
      (sum, row) => sum + row.durationMinutes + row.bufferMinutes,
      0,
    );
    counts.discountedVersusCatalogue += Number(terms.totalCents < catalogueTotal);
    counts.differentDuration += Number(duration !== terms.durationMinutes + terms.bufferMinutes);
    counts.differentQualifiedStaff += Number(
      terms.staffRefs.length !== terms.commonStaffRefs.length ||
        terms.commonStaffRefs.some((staff) => !terms.staffRefs.includes(staff)),
    );
  }
  return counts;
}

const bookedMember = z.object({
  id: z.number().int().positive(),
  service_price: sourceMoney,
  combo_children: z.array(z.unknown()).nullish(),
});
const bookedRoots = z.object({
  appointment: z.object({
    subbookings: z.array(z.record(z.string(), z.unknown())),
  }),
});

/** The source combo wrapper is never a sellable line. Its components carry the frozen prices. */
export function verifyBookedBooksyCombinations(model: BooksySourceReadModel) {
  const projected = new Map(model.appointments.map((row) => [row.id, row]));
  const counts = {
    combinations: 0,
    frozenComponents: 0,
    componentsOutsideProjection: 0,
    paidComponents: 0,
    invoicedComponents: 0,
    componentsWithoutInvoiceEvidence: 0,
  };
  for (const group of model.groups) {
    const raw = bookedRoots.safeParse(group.raw);
    if (!raw.success) continue;
    const roots = raw.data.appointment.subbookings.filter((row) => {
      if (row.combo_children == null) return false;
      if (!Array.isArray(row.combo_children))
        throw new Error("Booked Booksy combination has an invalid component list");
      return row.combo_children.length > 0;
    });
    if (!roots.length) continue;
    const frozen = new Map(
      group.ids.map((id) => {
        const row = projected.get(id);
        return [
          row?.sourceCopy?.itemRef,
          { line: row?.services[0], billing: model.contexts[id]?.rows[0] },
        ] as const;
      }),
    );
    const seen = new Set<number>();
    const total = (input: unknown): number => {
      const row = bookedMember.parse(input);
      const amount = booksyCents(row.service_price);
      if (row.combo_children?.length) {
        if (row.combo_children.reduce<number>((sum, child) => sum + total(child), 0) !== amount)
          throw new Error("Booked Booksy combination component prices differ from its total");
      } else {
        if (seen.has(row.id)) throw new Error("Booked Booksy combination repeats a component");
        seen.add(row.id);
        const { line, billing } = frozen.get(String(row.id)) ?? {};
        if (line) {
          if (line.sourceUnpriced || line.currency !== "EUR" || line.priceCents !== amount)
            throw new Error("Frozen price differs from the booked Booksy combination component");
          counts.frozenComponents++;
          counts.paidComponents += Number(billing?.paid === true);
          counts.invoicedComponents += Number(billing?.invoiced === true);
          counts.componentsWithoutInvoiceEvidence += Number(billing?.invoiced == null);
        } else counts.componentsOutsideProjection++;
      }
      return amount;
    };
    for (const root of roots) {
      total(root);
      counts.combinations++;
    }
  }
  return counts;
}
