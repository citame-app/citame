import { idSchema } from "@sob/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OwnReviews } from "~/features/reputation/reviews";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/account/reviews")({
  validateSearch: (search): { appointmentId?: string } => {
    const id = idSchema.safeParse(search.appointmentId);
    return id.success ? { appointmentId: id.data } : {};
  },
  component: AccountReviews,
});

function AccountReviews() {
  const { t } = useI18n();
  const { appointmentId } = Route.useSearch();
  return (
    <div className="space-y-4">
      {appointmentId && (
        <Link
          to="/account/reviews"
          search={{}}
          className="inline-flex min-h-11 items-center underline"
        >
          {t("reviews.request.all")}
        </Link>
      )}
      <OwnReviews key={appointmentId ?? "all"} appointmentId={appointmentId} />
    </div>
  );
}
