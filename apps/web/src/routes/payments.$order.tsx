import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { CheckoutPanel } from "~/features/admin/commerce/checkout-panel";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
export const Route = createFileRoute("/payments/$order")({
  beforeLoad: ({ context, location }) => {
    if (!context.session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
  },
  head: adminHead("commerce.returnTitle"),
  component: PaymentReturn,
});
function PaymentReturn() {
  const { t } = useI18n();
  const { order } = Route.useParams();
  const { session } = Route.useRouteContext();
  const result = useQuery({
    queryKey: ["commerce", "bank-order", order],
    queryFn: () => api().commerce.byOrder(order),
    retry: false,
  });
  return (
    <PageContainer width="max-w-2xl">
      <div className="py-8">
        <PageHeading title={t("commerce.returnTitle")} />
        {result.isPending ? (
          <Skeleton className="h-72" />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : (
          <CheckoutPanel
            id={result.data.id}
            bankPaymentId={result.data.payments.find((payment) => payment.order === order)?.id}
            mode="client"
            role={session?.user.role ?? "client"}
          />
        )}
      </div>
    </PageContainer>
  );
}
