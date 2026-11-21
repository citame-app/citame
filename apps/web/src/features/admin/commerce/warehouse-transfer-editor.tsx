import {
  MAX_STOCK_TRANSFER_LINES,
  type StockTransferInput,
  stockTransferInputSchema,
  type Warehouse,
  type WarehouseStock,
  type WarehouseStockQuery,
} from "@sob/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { InventoryPickerPager } from "./inventory-receipts";

type Balance = WarehouseStock["products"][number];

type TransferLine = { stock: Balance; quantity: string };

export type TransferReview = {
  source: string;
  destination: string;
  reason: string;
  generation: string;
  lines: TransferLine[];
};

export async function reviewTransferStock(
  source: string,
  lines: { productId: string; quantity: string }[],
) {
  const records = await Promise.all(
    lines.map(async ({ productId, quantity }) => {
      const result = await api().inventory.warehouseStock({ warehouseId: source, productId });
      const stock = result.products[0];
      if (!stock || !result.warehouse.active)
        throw new Error("The source warehouse or product is unavailable");
      return { line: { stock, quantity }, generation: result.generation };
    }),
  );
  const generation = records[0]?.generation;
  if (records.some((record) => record.generation !== generation))
    throw new Error("Inventory changed during review");
  return { lines: records.map((record) => record.line), generation };
}

export function TransferEditor({
  warehouses,
  generation,
  initialSource,
  recovered,
  busy,
  writable,
  error,
  onClose,
  onSave,
}: {
  warehouses: Warehouse[];
  generation: string;
  initialSource: string;
  recovered?: TransferReview;
  busy: boolean;
  writable: boolean;
  error: ReactNode;
  onClose: () => void;
  onSave: (command: StockTransferInput) => void;
}) {
  const { t } = useI18n();
  const heading = useId();
  const summary = useRef<HTMLParagraphElement>(null);
  const [source, setSource] = useState(recovered?.source ?? initialSource);
  const [destination, setDestination] = useState(recovered?.destination ?? "");
  const [reason, setReason] = useState(recovered?.reason ?? "");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<TransferLine[]>(recovered?.lines ?? []);
  const [page, setPage] = useState(1);
  const [reviewedGeneration, setReviewedGeneration] = useState(recovered?.generation ?? generation);
  const [invalid, setInvalid] = useState(false);
  const [leave, setLeave] = useState(false);
  const term = useDebounced(search.trim(), 200);
  const locations = warehouses.map((row) => ({
    value: row.id ?? "main",
    label: row.name ?? t("inventory.warehouse.main"),
  }));
  const searchQuery = {
    warehouseId: source,
    search: term,
    page,
    pageSize: 20,
    availableOnly: "1",
  } satisfies Partial<WarehouseStockQuery>;
  const products = useQuery({
    queryKey: ["inventory", "transfer-source", searchQuery],
    queryFn: () => api().inventory.warehouseStock(searchQuery),
  });
  const sourceValid = locations.some((location) => location.value === source);
  const destinationValid = locations.some(
    (location) => location.value === destination && destination !== source,
  );
  const dirty = Boolean(destination || reason || lines.length);
  const stale = reviewedGeneration !== generation;
  const review = useMutation({
    mutationFn: () =>
      reviewTransferStock(
        source,
        lines.map(({ stock, quantity }) => ({ productId: stock.productId, quantity })),
      ),
    onSuccess: (result) => {
      setReviewedGeneration(result.generation ?? generation);
      setLines(result.lines);
    },
  });
  return (
    <section className="space-y-4">
      <UnsavedGuard dirty={dirty && !busy} />
      <h3 id={heading} className="text-heading">
        {t("inventory.warehouse.newTransfer")}
      </h3>
      <form
        method="post"
        aria-labelledby={heading}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!writable || busy || review.isPending || stale) return;
          const command = stockTransferInputSchema.safeParse({
            sourceId: source === "main" ? null : source,
            destinationId: destination === "main" ? null : destination,
            reason,
            generation: reviewedGeneration,
            lines: lines.map(({ stock, quantity }) => ({
              productId: stock.productId,
              quantity: Number(quantity),
              version: stock.version,
            })),
          });
          const valid =
            command.success &&
            sourceValid &&
            destinationValid &&
            lines.every(({ stock, quantity }) => Number(quantity) <= stock.onHand - stock.reserved);
          setInvalid(!valid);
          if (valid) onSave(command.data);
          else requestAnimationFrame(() => summary.current?.focus());
        }}
      >
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{t("inventory.warehouse.title")}</legend>
          <SelectField
            name="source"
            className="min-w-0"
            label={t("inventory.warehouse.source")}
            value={source}
            options={locations}
            disabled={busy || review.isPending || lines.length > 0}
            onChange={(value) => {
              setSource(value);
              if (destination === value) setDestination("");
            }}
          />
          <SelectField
            name="destination"
            className="min-w-0"
            label={t("inventory.warehouse.destination")}
            value={destination}
            required
            disabled={busy || review.isPending}
            options={[
              { value: "", label: t("inventory.warehouse.chooseDestination") },
              ...locations.filter((row) => row.value !== source),
            ]}
            onChange={setDestination}
          />
        </fieldset>
        <TextAreaField
          name="reason"
          label={t("inventory.reason")}
          required
          maxLength={300}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {lines.length < MAX_STOCK_TRANSFER_LINES && (
          <>
            <TextField
              name="productSearch"
              label={t("inventory.search")}
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <SelectField
              name="product"
              label={t("inventory.receipts.addProduct")}
              value=""
              disabled={busy || review.isPending || stale || !products.data}
              options={[
                { value: "", label: t("inventory.receipts.chooseProduct") },
                ...(products.data?.products
                  .filter(
                    (row) =>
                      row.onHand > row.reserved &&
                      !lines.some((line) => line.stock.productId === row.productId),
                  )
                  .map((row) => ({
                    value: row.productId,
                    label: `${row.name} · ${row.sku} (${row.onHand - row.reserved})`,
                  })) ?? []),
              ]}
              onChange={(value) => {
                const stock = products.data?.products.find((row) => row.productId === value);
                if (stock && products.data?.generation === reviewedGeneration) {
                  setLines((current) => [...current, { stock, quantity: "1" }]);
                  setSearch("");
                  setPage(1);
                }
              }}
            />
            {products.data && (
              <InventoryPickerPager pagination={products.data.pagination} onChange={setPage} />
            )}
            {products.isError && (
              <ErrorState error={products.error} onRetry={() => void products.refetch()} />
            )}
          </>
        )}
        {lines.map(({ stock, quantity }) => (
          <fieldset
            key={stock.productId}
            className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-3"
          >
            <legend className="max-w-full break-all px-2 font-medium">
              {stock.name} · {stock.sku}
            </legend>
            <p className="text-muted">
              {t("inventory.warehouse.remaining", { count: stock.onHand - stock.reserved })}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                name={`quantity-${stock.productId}`}
                inputMode="numeric"
                pattern="[1-9][0-9]{0,8}"
                required
                label={t("inventory.quantity")}
                value={quantity}
                disabled={busy || review.isPending}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((line) =>
                      line.stock.productId === stock.productId
                        ? { ...line, quantity: event.target.value }
                        : line,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                disabled={busy || review.isPending}
                onClick={() =>
                  setLines((current) =>
                    current.filter((line) => line.stock.productId !== stock.productId),
                  )
                }
              >
                {t("inventory.receipts.removeLine")}
              </Button>
            </div>
          </fieldset>
        ))}
        {invalid && (
          <p ref={summary} role="alert" tabIndex={-1}>
            {t("inventory.warehouse.invalidTransfer")}
          </p>
        )}
        {error}
        {review.isError && <ErrorState error={review.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!writable || busy || review.isPending || stale}>
            {t("inventory.warehouse.recordTransfer")}
          </Button>
          {(stale || error) && (
            <Button
              type="button"
              variant="secondary"
              disabled={!writable || busy || review.isPending}
              onClick={() => review.mutate()}
            >
              {t("inventory.warehouse.reload")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={busy || review.isPending}
            onClick={() => (dirty ? setLeave(true) : onClose())}
          >
            {t("inventory.warehouse.back")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={leave}
        onOpenChange={setLeave}
        destructive
        title={t("admin.unsaved.title")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={onClose}
      />
    </section>
  );
}
