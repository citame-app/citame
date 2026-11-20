import { idSchema, localDateSchema } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { WaitlistView } from "~/features/waitlist/waitlist-view";
import { createTranslator } from "~/i18n";
import { salonQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";
export const Route = createFileRoute("/account/waitlist")({
  beforeLoad: ({ context }): void => {
    if (context.session && context.session.user.role !== "client")
      throw redirect({ to: "/admin/calendar" });
  },
  validateSearch: (
    raw: Record<string, unknown>,
  ): { services?: string; staff?: string; date?: string } => {
    const services =
      typeof raw.services === "string"
        ? [
            ...new Set(raw.services.split(",").filter((id) => idSchema.safeParse(id).success)),
          ].slice(0, 8)
        : [];
    const staff = idSchema.safeParse(raw.staff);
    const date = localDateSchema.safeParse(raw.date);
    return {
      ...(services.length ? { services: services.join(",") } : {}),
      ...(staff.success ? { staff: staff.data } : {}),
      ...(date.success ? { date: date.data } : {}),
    };
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("waitlist.title"),
        description: t("waitlist.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: WaitlistPage,
});
function WaitlistPage() {
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const { data: salon } = useQuery({ ...salonQuery, refetchOnMount: "always" });
  if (!session) return null;
  return (
    <WaitlistView
      mode="client"
      role="client"
      onlineBookingEnabled={salon?.onlineBookingEnabled}
      clientId={session.clientId}
      initialServices={search.services?.split(",")}
      initialStaff={search.staff}
      initialDate={search.date}
    />
  );
}
