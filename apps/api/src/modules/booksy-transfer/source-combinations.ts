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
});
const combo = variant.extend({
  combo_children: z
    .array(z.object({ service_variant: z.object({ id: variant.shape.id }), price: sourceMoney }))
    .min(2),
});

function isCombination(service: Service) {
  return typeof service.raw.combo_type === "string" && service.raw.combo_type.length > 0;
}

/** Preserve source IDs and frozen booking references, while preventing standalone booking. */
export function holdBooksyCombinations(services: Service[]): Service[] {
  return services.map((service) =>
    isCombination(service) && service.active ? { ...service, active: false } : service,
  );
}

/** Aggregate differences from Citame's current catalogue-priced, same-professional shortcuts. */
export function reviewBooksyCombinations(services: readonly Service[]) {
  const originals = new Map<number, { service: Service; staff: Set<number> }>();
  const ambiguous = new Set<number>();
  for (const service of services) {
    if (isCombination(service)) continue;
    const parsed = z.array(variant).safeParse(service.raw.variants);
    if (!parsed.success) continue;
    for (const row of parsed.data) {
      if (originals.has(row.id)) ambiguous.add(row.id);
      originals.set(row.id, { service, staff: new Set(row.staffers) });
    }
  }
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
  for (const service of services.filter(isCombination)) {
    counts.captured++;
    counts.held += Number(!service.active);
    counts.publiclyOfferedAtSource += Number(
      service.raw.is_available_for_customer_booking === true,
    );
    const parsed = z.tuple([combo]).safeParse(service.raw.variants);
    if (!parsed.success) {
      counts.unverifiedTerms++;
      continue;
    }
    const [terms] = parsed.data;
    const components = terms.combo_children.map(({ service_variant: { id } }) =>
      ambiguous.has(id) ? undefined : originals.get(id),
    );
    if (components.some((component) => component === undefined)) {
      counts.unverifiedTerms++;
      continue;
    }
    let capturedTotal: number;
    let componentTotal: number;
    try {
      capturedTotal = booksyCents(terms.price);
      componentTotal = terms.combo_children.reduce((sum, row) => sum + booksyCents(row.price), 0);
    } catch {
      counts.unverifiedTerms++;
      continue;
    }
    const resolved = components.filter((component) => component !== undefined);
    const catalogueTotal = resolved.reduce((sum, row) => sum + row.service.priceCents, 0);
    const duration = resolved.reduce(
      (sum, row) => sum + row.service.durationMinutes + row.service.bufferMinutes,
      0,
    );
    const qualified = [...resolved[0]!.staff].filter((staff) =>
      resolved.every((row) => row.staff.has(staff)),
    );
    const sourceStaff = new Set(terms.staffers);
    counts.discountedVersusCatalogue += Number(capturedTotal < catalogueTotal);
    counts.differentDuration += Number(
      duration !== service.durationMinutes + service.bufferMinutes,
    );
    counts.componentPriceMismatch += Number(componentTotal !== capturedTotal);
    counts.differentQualifiedStaff += Number(
      qualified.length !== sourceStaff.size || qualified.some((staff) => !sourceStaff.has(staff)),
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
