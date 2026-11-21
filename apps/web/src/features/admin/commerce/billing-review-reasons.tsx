import type { BillingReviewReason } from "@sob/contracts";
import { useI18n } from "~/i18n/react";

const messageFor = {
  unknown_amount: "pos.billingReview.unknownAmount",
  paid_in_booksy: "pos.billingReview.paidInBooksy",
  invoiced_in_booksy: "pos.billingReview.invoicedInBooksy",
  unknown_booksy_payment: "pos.billingReview.unknownPayment",
} as const satisfies Record<BillingReviewReason, string>;

export function BillingReviewReasons({ reasons }: { reasons: readonly BillingReviewReason[] }) {
  const { t } = useI18n();
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
      {reasons.map((reason) => (
        <li key={reason}>{t(messageFor[reason])}</li>
      ))}
    </ul>
  );
}
