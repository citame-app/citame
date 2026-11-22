import { idSchema, permissionsFor } from "@sob/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { RewardsView } from "~/features/admin/commerce/rewards-view";
export const Route = createFileRoute("/account/rewards")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { stamps?: boolean; giftOffer?: string; giftCard?: string } => ({
    stamps: search.stamps === true ? true : undefined,
    giftOffer: idSchema.safeParse(search.giftOffer).data,
    giftCard: idSchema.safeParse(search.giftCard).data,
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
  const { stamps, giftOffer, giftCard } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!session) return null;
  return (
    <RewardsView
      key={stamps ? "stamps" : "default"}
      initialTab={stamps ? "stamps" : undefined}
      mode={session.user.role === "client" ? "client" : "admin"}
      role={session.user.role}
      accessPreset={session.accessPreset}
      clientId={session.clientId}
      giftNavigation={{
        review: giftOffer ? { actorId: session.user.id, offerId: giftOffer } : undefined,
        cardId: giftCard,
        setCard: (id) => void navigate({ search: id ? { giftCard: id } : {}, replace: true }),
      }}
    />
  );
}
