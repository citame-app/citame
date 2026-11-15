import type { Product } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
export type CartProduct = { product: Product; quantity: string };
export function ProductCart({
  items,
  onChange,
}: {
  items: CartProduct[];
  onChange: (items: CartProduct[]) => void;
}) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const products = useQuery({
    queryKey: ["inventory", "picker", search],
    queryFn: () => api().inventory.list({ search, pageSize: 100 }),
  });
  return (
    <fieldset className="space-y-3 rounded-lg border border-line p-3 sm:col-span-2">
      <legend className="px-1 font-semibold">{t("inventory.cart")}</legend>
      <p className="text-sm text-muted">{t("inventory.cartHelp")}</p>
      <TextField
        label={t("inventory.search")}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setSelected("");
        }}
      />
      {products.isPending ? (
        <Skeleton className="h-12" />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            className="min-w-0 flex-1"
            label={t("inventory.pick")}
            value={selected}
            options={[
              { value: "", label: t("inventory.pick") },
              ...products.data.products.map((p) => ({
                value: p.id,
                label: `${p.name} · ${formatMoney(p.priceCents, "EUR", locale)} · ${p.available}`,
                disabled: p.available === 0 || items.some((item) => item.product.id === p.id),
              })),
            ]}
            onChange={setSelected}
          />
          <Button
            variant="secondary"
            disabled={!selected}
            onClick={() => {
              const product = products.data.products.find((p) => p.id === selected);
              if (product && !items.some((item) => item.product.id === product.id))
                onChange([...items, { product, quantity: "1" }]);
              setSelected("");
            }}
          >
            {t("inventory.add")}
          </Button>
        </div>
      )}
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.product.id}
            className="flex flex-wrap items-end gap-3 border-t border-line pt-3"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{item.product.name}</p>
              <p className="text-sm text-muted">
                {formatMoney(item.product.priceCents, "EUR", locale)}
              </p>
            </div>
            <TextField
              className="w-24"
              label={t("inventory.quantity")}
              value={item.quantity}
              inputMode="numeric"
              onChange={(e) =>
                onChange(
                  items.map((row) =>
                    row.product.id === item.product.id ? { ...row, quantity: e.target.value } : row,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              aria-label={`${t("inventory.remove")} ${item.product.name}`}
              onClick={() => onChange(items.filter((row) => row.product.id !== item.product.id))}
            >
              {t("inventory.remove")}
            </Button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
