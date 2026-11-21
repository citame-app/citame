import { idSchema } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import {
  COMMERCE_VIEWS,
  CommerceView,
  type CommerceViewName,
} from "~/features/admin/commerce/commerce-view";
import {
  type InventoryNavigation,
  parseInventoryNavigation,
} from "~/features/admin/commerce/inventory-navigation";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";
export const Route = createFileRoute("/admin/commerce")({
  validateSearch: (
    search: Record<string, unknown>,
  ): InventoryNavigation & { view: CommerceViewName; checkout?: string } => ({
    view: COMMERCE_VIEWS.includes(search.view as CommerceViewName)
      ? (search.view as CommerceViewName)
      : "sale",
    ...(idSchema.safeParse(search.checkout).success ? { checkout: String(search.checkout) } : {}),
    ...(search.view === "inventory" ? parseInventoryNavigation(search) : {}),
  }),
  head: adminHead("commerce.title"),
  component: SalesPage,
});
function SalesPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!session) return null;
  return (
    <div className="view-commerce">
      <PageHeading title={t("commerce.title")} lead={t("commerce.lead")} />
      <CommerceView
        role={session.user.role}
        userId={session.user.id}
        accessPreset={session.accessPreset}
        view={search.view}
        checkoutId={search.checkout}
        inventoryNavigation={search}
        onInventoryNavigation={(next, replace) =>
          void navigate({ search: { view: "inventory", ...next }, replace })
        }
        onViewChange={(view) => void navigate({ search: { view }, replace: false })}
        onCheckoutChange={(id) =>
          void navigate({ search: { ...search, checkout: id ?? undefined }, replace: !id })
        }
      />
    </div>
  );
}
