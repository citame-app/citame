import { permissionsFor } from "@sob/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { RewardsView } from "~/features/admin/commerce/rewards-view";
export const Route = createFileRoute("/account/rewards")({
  beforeLoad: ({ context }) => {
    if (
      context.session &&
      context.session.user.role !== "client" &&
      !permissionsFor(context.session.user.role, context.session.accessPreset).commerce
    )
      throw redirect({ to: "/admin" });
  },
  component: RewardsPage,
});
function RewardsPage() {
  const { session } = Route.useRouteContext();
  if (!session) return null;
  return (
    <RewardsView
      mode={session.user.role === "client" ? "client" : "admin"}
      role={session.user.role}
      accessPreset={session.accessPreset}
    />
  );
}
