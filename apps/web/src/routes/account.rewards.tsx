import { permissionsFor } from "@sob/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { RewardsView } from "~/features/admin/commerce/rewards-view";
export const Route = createFileRoute("/account/rewards")({
  validateSearch: (search: Record<string, unknown>): { stamps?: boolean } => ({
    stamps: search.stamps === true ? true : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (
      context.session &&
      context.session.user.role !== "client" &&
      !permissionsFor(context.session.user.role, context.session.accessPreset).commerce
    )
      throw redirect({ to: "/admin/calendar" });
  },
  component: RewardsPage,
});
function RewardsPage() {
  const { session } = Route.useRouteContext();
  const { stamps } = Route.useSearch();
  if (!session) return null;
  return (
    <RewardsView
      key={stamps ? "stamps" : "default"}
      initialTab={stamps ? "stamps" : undefined}
      mode={session.user.role === "client" ? "client" : "admin"}
      role={session.user.role}
      accessPreset={session.accessPreset}
      clientId={session.clientId}
    />
  );
}
