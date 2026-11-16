import { createFileRoute } from "@tanstack/react-router";
import { BookingWidget } from "~/features/acquisition/widget";
import { parseBookingSearch } from "~/features/booking/search";
import { createTranslator } from "~/i18n";
import { servicesQuery, staffQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";
export const Route = createFileRoute("/widget")({
  validateSearch: (raw: Record<string, unknown>): { services?: string; staff?: string } => {
    const input = parseBookingSearch(raw);
    return {
      ...(input.services.length ? { services: input.services.slice(0, 24).join(",") } : {}),
      ...(input.staff && input.staff !== "any" ? { staff: input.staff } : {}),
    };
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.prefetchQuery(servicesQuery),
      context.queryClient.prefetchQuery(staffQuery),
    ]);
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("widget.title", { name: salon.name }),
        description: t("widget.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: Page,
});
function Page() {
  const { salon } = Route.useRouteContext();
  const search = Route.useSearch();
  return (
    <BookingWidget
      salonName={salon.name}
      initialSelection={{
        serviceIds: search.services?.split(",") ?? [],
        ...(search.staff ? { staffId: search.staff } : {}),
      }}
    />
  );
}
