import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { Skeleton } from "~/components/ui/states";
import { parseBookingSearch, serializeBookingSearch } from "~/features/booking/search";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";

type BookingUrlSearch = {
  services?: string;
  staff?: string;
  date?: string;
  slot?: string;
  slotStaff?: string;
  professionals?: string;
  visitStaff?: string;
};

export const Route = createFileRoute("/book")({
  // Sanitize what arrives in the URL: invalid values are dropped, never trusted.
  validateSearch: (raw: Record<string, unknown>): BookingUrlSearch =>
    serializeBookingSearch(parseBookingSearch(raw)),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(servicesQuery),
      context.queryClient.ensureQueryData(staffQuery),
      context.queryClient.fetchQuery({ ...salonQuery, staleTime: 5_000 }),
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
  component: BookingLayout,
});

function BookingLayout() {
  const { t } = useI18n();
  const { data: salon } = useQuery({ ...salonQuery, refetchOnWindowFocus: "always" });
  const isConfirmation = useRouterState({
    select: (state) => state.location.pathname.startsWith("/book/confirmed/"),
  });
  if (salon?.onlineBookingEnabled !== false || isConfirmation) return <Outlet />;
  return (
    <PageContainer width="max-w-6xl">
      <h1 className="mb-4 text-heading">{t("booking.paused.title")}</h1>
      <p className="text-muted">{t("booking.paused.body")}</p>
    </PageContainer>
  );
}
