import { giftCardCodeSchema } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
export function GiftBalanceChecker({ mode }: { mode: CommerceMode }) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const [code, setCode] = useState("");
  const check = useMutation({
    mutationFn: () => api().giftCards.check(giftCardCodeSchema.parse(code), mode),
  });
  const money = (value: number) => formatMoney(value, "EUR", locale);
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        check.mutate();
      }}
    >
      <h3 className="font-semibold">{t("gift.check")}</h3>
      <TextField
        label={t("gift.code")}
        value={code}
        autoComplete="off"
        maxLength={80}
        onChange={(event) => {
          setCode(event.target.value);
          check.reset();
        }}
      />
      <Button type="submit" variant="secondary" disabled={!online || check.isPending}>
        {t("gift.check")}
      </Button>
      {check.isError && (
        <p role="alert" className="text-danger-fg">
          {t("gift.checkError")}
        </p>
      )}
      {check.data && (
        <div role="status" className="text-sm">
          <p>{t(`gift.status.${check.data.status}`)}</p>
          <p>{t("gift.available", { amount: money(check.data.availableCents) })}</p>
          <p>{t("gift.reserved", { amount: money(check.data.reservedCents) })}</p>
        </div>
      )}
    </form>
  );
}
