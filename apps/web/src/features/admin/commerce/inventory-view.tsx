import type { Product, UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { centsInput, inputCents } from "./money";
export function InventoryView({ role }: { role: UserRole }) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<"active" | "inactive" | "all">("active");
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Product | "new" | null>(null);
  const products = useQuery({
    queryKey: ["inventory", { search, active, lowStock, page }],
    queryFn: () => api().inventory.list({ search, active, lowStock, page }),
  });
  if (selected)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelected(null)}>
          {t("inventory.back")}
        </Button>
        <ProductEditor
          key={selected === "new" ? "new" : `${selected.id}-${selected.version}`}
          product={selected === "new" ? null : selected}
          onSaved={setSelected}
        />
      </div>
    );
  return (
    <section aria-label={t("inventory.title")} className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("inventory.title")}</h2>
          <p className="text-muted">{t("inventory.lead")}</p>
        </div>
        {role === "owner" && (
          <Button onClick={() => setSelected("new")}>{t("inventory.new")}</Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("inventory.search")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label={t("inventory.filter")}
          value={active}
          options={[
            { value: "active", label: t("inventory.active") },
            { value: "inactive", label: t("inventory.inactive") },
            { value: "all", label: t("inventory.all") },
          ]}
          onChange={(value) => {
            setActive(value as typeof active);
            setPage(1);
          }}
        />
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(e) => {
              setLowStock(e.target.checked);
              setPage(1);
            }}
          />
          {t("inventory.onlyLow")}
        </label>
      </div>
      {products.isPending ? (
        <Skeleton className="h-48" />
      ) : products.isError ? (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      ) : products.data.products.length === 0 ? (
        <EmptyState title={t("inventory.empty")} description={t("inventory.emptyHelp")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {products.data.products.map((p) => (
            <li key={p.id} className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <h3 className="font-semibold">{p.name}</h3>
              <p className="break-all text-sm text-muted">{p.sku}</p>
              <p>{formatMoney(p.priceCents, "EUR", locale)}</p>
              <div className="text-sm">
                <p>{t("inventory.onHand", { count: p.stockOnHand })}</p>
                <p>{t("inventory.available", { count: p.available })}</p>
                <p>{t("inventory.reserved", { count: p.stockReserved })}</p>
              </div>
              {p.lowStock && <p className="font-medium text-danger-fg">{t("inventory.low")}</p>}
              {role === "owner" && (
                <Button variant="secondary" onClick={() => setSelected(p)}>
                  {t("inventory.manage")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {products.data && (
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
            {t("inventory.previous")}
          </Button>
          <span className="self-center tabular-nums">{page}</span>
          <Button
            variant="secondary"
            disabled={page * products.data.pagination.pageSize >= products.data.pagination.total}
            onClick={() => setPage(page + 1)}
          >
            {t("inventory.next")}
          </Button>
        </div>
      )}
    </section>
  );
}
function ProductEditor({
  product,
  onSaved,
}: {
  product: Product | null;
  onSaved: (product: Product) => void;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [values, setValues] = useState({
    name: product?.name ?? "",
    sku: product?.sku ?? "",
    barcode: product?.barcode ?? "",
    price: product ? centsInput(product.priceCents) : "",
    cost: product?.costCents == null ? "" : centsInput(product.costCents),
    tax: String((product?.taxBasisPoints ?? 0) / 100),
    unit: product?.unitLabel ?? "unit",
    location: product?.storageLocation ?? "",
    threshold: String(product?.lowStockThreshold ?? 0),
    opening: "0",
  });
  const [key, setKey] = useState(() => crypto.randomUUID());
  const changed = async (p: Product) => {
    await queries.invalidateQueries({ queryKey: ["inventory"] });
    onSaved(p);
  };
  const save = useMutation({
    mutationFn: () => {
      const priceCents = inputCents(values.price);
      const costCents = values.cost.trim() ? inputCents(values.cost) : null;
      const taxBasisPoints = inputCents(values.tax);
      const lowStockThreshold = Number(values.threshold);
      const openingStock = Number(values.opening);
      if (
        priceCents === null ||
        (values.cost.trim() && costCents === null) ||
        taxBasisPoints === null ||
        taxBasisPoints > 10000 ||
        !Number.isInteger(lowStockThreshold) ||
        lowStockThreshold < 0 ||
        !Number.isInteger(openingStock) ||
        openingStock < 0
      )
        throw new Error("Invalid product values");
      const input = {
        name: values.name.trim(),
        sku: values.sku.trim(),
        barcode: values.barcode.trim() || null,
        priceCents,
        costCents,
        taxBasisPoints,
        unitLabel: values.unit.trim(),
        storageLocation: values.location.trim() || null,
        lowStockThreshold,
      };
      return product
        ? api().inventory.update(product.id, { ...input, version: product.version })
        : api().inventory.create({ ...input, openingStock, idempotencyKey: key });
    },
    onSuccess: changed,
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!product) throw new Error("Missing product");
      return api().inventory.update(product.id, {
        active: !product.active,
        version: product.version,
      });
    },
    onSuccess: changed,
  });
  const fields = [
    ["name", "inventory.name"],
    ["sku", "inventory.sku"],
    ["barcode", "inventory.barcode"],
    ["price", "inventory.price"],
    ["cost", "inventory.cost"],
    ["tax", "inventory.tax"],
    ["unit", "inventory.unit"],
    ["location", "inventory.location"],
    ["threshold", "inventory.threshold"],
    ...(!product ? [["opening", "inventory.opening"]] : []),
  ] as [keyof typeof values, Parameters<typeof t>[0]][];
  return (
    <div className="space-y-6">
      <form
        className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h3 className="font-semibold sm:col-span-2">
          {t(product ? "inventory.edit" : "inventory.new")}
        </h3>
        {fields.map(([field, label]) => (
          <TextField
            key={field}
            label={t(label)}
            value={values[field]}
            inputMode={
              ["price", "cost", "tax"].includes(field)
                ? "decimal"
                : ["threshold", "opening"].includes(field)
                  ? "numeric"
                  : "text"
            }
            onChange={(e) => {
              setValues({ ...values, [field]: e.target.value });
              setKey(crypto.randomUUID());
              save.reset();
            }}
          />
        ))}
        <p className="text-sm text-muted sm:col-span-2">{t("inventory.optionalCost")}</p>
        {(save.isError || archive.isError) && (
          <p role="alert" className="text-danger-fg">
            {t("inventory.error")}
          </p>
        )}
        <Button type="submit" disabled={!online || save.isPending || archive.isPending}>
          {t("inventory.save")}
        </Button>
        {product && (
          <Button
            variant="secondary"
            disabled={!online || archive.isPending || save.isPending}
            onClick={() => archive.mutate()}
          >
            {t(product.active ? "inventory.archive" : "inventory.restore")}
          </Button>
        )}
      </form>
      {product && (
        <>
          <StockAdjustment product={product} onSaved={changed} />
          <StockHistory product={product} />
        </>
      )}
    </div>
  );
}
function StockAdjustment({
  product,
  onSaved,
}: {
  product: Product;
  onSaved: (p: Product) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const [kind, setKind] = useState<"receive" | "consume" | "count">("receive");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: () => {
      const amount = Number(quantity);
      if (
        !quantity.trim() ||
        !Number.isInteger(amount) ||
        amount < (kind === "count" ? 0 : 1) ||
        reason.trim().length < 3
      )
        throw new Error("Invalid stock movement");
      return api().inventory.move(product.id, {
        kind,
        quantity: amount,
        reason: reason.trim(),
        version: product.version,
        idempotencyKey: key,
      });
    },
    onSuccess: onSaved,
  });
  const reset = () => {
    setKey(crypto.randomUUID());
    save.reset();
  };
  return (
    <form
      className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("inventory.movement")}</h3>
      <SelectField
        label={t("inventory.movement")}
        value={kind}
        options={["receive", "consume", "count"].map((value) => ({
          value,
          label: t(`inventory.${value as "receive" | "consume" | "count"}`),
        }))}
        onChange={(v) => {
          setKind(v as typeof kind);
          reset();
        }}
      />
      <TextField
        label={t("inventory.quantity")}
        value={quantity}
        inputMode="numeric"
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
      <Button type="submit" disabled={save.isPending || !online}>
        {t("inventory.record")}
      </Button>
    </form>
  );
}
function StockHistory({ product }: { product: Product }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ["inventory", product.id, "movements", product.version, page],
    queryFn: () => api().inventory.movements(product.id, page),
  });
  return (
    <section className="space-y-3">
      <h3 className="text-heading">{t("inventory.history")}</h3>
      {history.isPending ? (
        <Skeleton className="h-20" />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {history.data.movements.map((move) => (
              <li key={move.id} className="flex flex-wrap justify-between gap-3 py-3">
                <div>
                  <p>{move.reason}</p>
                  <p className="text-sm text-muted">
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(move.createdAt))}
                  </p>
                </div>
                <span className="tabular-nums">
                  {move.quantityDelta > 0 ? "+" : ""}
                  {move.quantityDelta}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
              {t("inventory.previous")}
            </Button>
            <Button
              variant="secondary"
              disabled={page * history.data.pagination.pageSize >= history.data.pagination.total}
              onClick={() => setPage(page + 1)}
            >
              {t("inventory.next")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
