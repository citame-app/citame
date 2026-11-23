import { combinationCreateSchema } from "@sob/contracts";
import { sourceUuid } from "./plan";
import { sourceBooksyCombinationTerms } from "./source-combinations";
import type { BooksySourceReadModel } from "./source-read-model";

export function booksyCombinationDrafts(model: Pick<BooksySourceReadModel, "base" | "businessId">) {
  const services = new Map(model.base.services.map((service) => [service.sourceId, service]));
  const staff = new Set(model.base.staff.map((member) => member.sourceId));
  return sourceBooksyCombinationTerms(model.base.services).map((source) => {
    const item = services.get(source.sourceId);
    if (!source.terms || !item || source.terms.staffRefs.some((ref) => !staff.has(ref))) {
      return { sourceId: source.sourceId, draft: null, issue: source.issue ?? "unmapped_staff" };
    }
    const draft = combinationCreateSchema.safeParse({
      name: item.name,
      description: item.description,
      active: false,
      serviceIds: source.terms.components.map(({ serviceRef }) =>
        sourceUuid(model.businessId, "services", serviceRef),
      ),
      fixedTerms: {
        pricesCents: source.terms.components.map(({ priceCents }) => priceCents),
        staffIds: source.terms.staffRefs.map((ref) => sourceUuid(model.businessId, "staff", ref)),
      },
      idempotencyKey: sourceUuid(model.businessId, "combination-draft-write", source.sourceId),
    });
    if (!draft.success)
      return { sourceId: source.sourceId, draft: null, issue: "invalid_native_draft" };
    return {
      sourceId: source.sourceId,
      id: sourceUuid(model.businessId, "serviceCombinations", source.sourceId),
      originallyPublic: source.publiclyAvailable,
      draft: draft.data,
      issue: null,
    };
  });
}
