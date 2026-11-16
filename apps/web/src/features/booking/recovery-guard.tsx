import { useBlocker } from "@tanstack/react-router";
import type { RefObject } from "react";
import { ConfirmDialog } from "~/components/ui/dialog";
import { useI18n } from "~/i18n/react";
export function BookingRecoveryGuard({ pending }: { pending: RefObject<boolean> }) {
  const { t } = useI18n();
  const blocker = useBlocker({
    shouldBlockFn: () => pending.current,
    enableBeforeUnload: () => pending.current,
    withResolver: true,
  });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") blocker.reset();
      }}
      title={t("bookingPromotion.recoveryTitle")}
      description={t("bookingPromotion.recoveryBody")}
      confirmLabel={t("bookingPromotion.leave")}
      cancelLabel={t("bookingPromotion.stay")}
      onConfirm={() => blocker.status === "blocked" && blocker.proceed()}
    />
  );
}
