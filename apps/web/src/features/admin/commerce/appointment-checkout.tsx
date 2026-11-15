import type { UserRole } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Sheet } from "~/components/ui/sheet";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { CheckoutPanel } from "./checkout-panel";
export function AppointmentCheckout({
  appointmentId,
  mode,
  role,
  disabled,
}: {
  appointmentId: string;
  mode: CommerceMode;
  role: UserRole;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api().commerce.create(
        {
          appointmentId,
          currency: "EUR",
          lines: [],
          discountCents: 0,
          tipCents: 0,
          idempotencyKey: requestKey,
        },
        mode,
      ),
    onSuccess: (sale) => setSelected(sale.id),
  });
  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled || start.isPending}
        onClick={() => start.mutate()}
      >
        {t(mode === "client" ? "commerce.continue" : "commerce.create")}
      </Button>
      {start.isError && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.paymentError")}
        </p>
      )}
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setRequestKey(crypto.randomUUID());
          }
        }}
        title={t("commerce.receipt")}
        size="lg"
      >
        {selected && <CheckoutPanel id={selected} mode={mode} role={role} />}
      </Sheet>
    </>
  );
}
