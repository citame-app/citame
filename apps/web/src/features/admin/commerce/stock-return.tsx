import type { Checkout } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
export function StockReturn({ checkout }: { checkout: Checkout }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const lines = checkout.lines.filter((line) => line.kind === "product");
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: () => {
      const count = Number(quantity);
      if (!Number.isInteger(count) || count < 1 || reason.trim().length < 3)
        throw new Error("Invalid return");
      return api().inventory.returnStock({
        checkoutLineId: lineId,
        quantity: count,
        reason: reason.trim(),
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
  const reset = () => {
    save.reset();
    setKey(crypto.randomUUID());
  };
  return (
    <details>
      <summary className="cursor-pointer py-2 font-medium">{t("inventory.return")}</summary>
      <p className="my-2 text-sm text-muted">{t("inventory.returnHelp")}</p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <SelectField
          label={t("inventory.returnLine")}
          value={lineId}
          options={lines.map((line) => ({ value: line.id, label: line.description }))}
          onChange={(value) => {
            setLineId(value);
            reset();
          }}
        />
        <TextField
          label={t("inventory.quantity")}
          inputMode="numeric"
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value);
            reset();
          }}
        />
        <TextField
          label={t("inventory.reason")}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            reset();
          }}
        />
        {save.isError && (
          <p role="alert" className="text-danger-fg">
            {t("inventory.error")}
          </p>
        )}
        {save.isSuccess && <p role="status">{t("inventory.returnDone")}</p>}
        <Button type="submit" disabled={!online || save.isPending || save.isSuccess}>
          {t("inventory.return")}
        </Button>
      </form>
    </details>
  );
}
