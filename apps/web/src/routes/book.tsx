import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { Skeleton } from "~/components/ui/states";
import { parseBookingSearch, serializeBookingSearch } from "~/features/booking/search";
import { createTranslator } from "~/i18n";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";

type BookingUrlSearch = {
  services?: string;
  staff?: string;
  date?: string;
  slot?: string;
  slotStaff?: string;
};

export const Route = createFileRoute("/book")({
  // Sanitize what arrives in the URL: invalid values are dropped, never trusted.
  validateSearch: (raw: Record<string, unknown>): BookingUrlSearch =>
    serializeBookingSearch(parseBookingSearch(raw)),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(servicesQuery),
      context.queryClient.ensureQueryData(staffQuery),
      context.queryClient.ensureQueryData(salonQuery),
    ]);
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("seo.book.title"),
        description: t("seo.book.description", { name: salon.name }),
        siteName: salon.name,
        locale,
      }),
    };
  },
  pendingComponent: () => (
    <PageContainer width="max-w-6xl">
      <div className="space-y-4 py-10" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </PageContainer>
  ),
  component: Outlet,
});
