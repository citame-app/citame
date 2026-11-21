import {
  MAX_STOCK_RECEIPT_LINES,
  type PageInfo,
  type Product,
  type PurchaseOrder,
  type StockReceipt,
  type StockReceiptInput,
  type Supplier,
  stockReceiptInputSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/ui/data-table";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatMoney, localDateOf } from "~/lib/format";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { receiptRequests } from "./inventory-requests";

export function InventoryReceipts({
  canWrite,
  readCosts,
  userId,
  picked,
  onPick,
  onOrder,
  onEditingChange,
  page,
  onPageChange,
}: {
  canWrite: boolean;
  readCosts: boolean;
  userId?: string;
  picked: string | null;
  onPick: (id: string | null) => void;
  onOrder: (id: string) => void;
  onEditingChange: (editing: boolean) => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { t, locale } = useI18n();
  const [creating, setCreating] = useState(false);
  useEffect(() => () => onEditingChange(false), [onEditingChange]);
  const list = useQuery({
    queryKey: ["inventory", "receipts", page],
    queryFn: () => api().inventory.receipts({ page }),
    enabled: !creating && !picked,
  });
  const detail = useQuery({
    queryKey: ["inventory", "receipt", picked, readCosts],
    queryFn: () => api().inventory.receipt(picked ?? ""),
    enabled: !!picked,
  });
  if (creating && canWrite && userId)
    return (
      <ReceiptEditor
        key={userId}
        userId={userId}
        onClose={() => {
          setCreating(false);
          onEditingChange(false);
        }}
        onSaved={(id) => {
          setCreating(false);
          onEditingChange(false);
          onPick(id);
        }}
      />
    );
  if (picked) {
    const receipt = detail.isError ? undefined : detail.data;
    return (
      <section className="space-y-4">
        <Button variant="ghost" onClick={() => onPick(null)}>
          {t("inventory.receipts.back")}
        </Button>
        {detail.isError && (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        )}
        {detail.isPending && <p role="status">{t("admin.loading")}</p>}
        {receipt && (
          <>
            <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
              <h3 className="text-heading">
                {t("inventory.receipts.number", { number: receipt.number })}
              </h3>
              <p>
                {formatDateWithYear(receipt.receivedOn, locale)} ·{" "}
                {receipt.supplierName ?? t("inventory.receipts.noSupplier")}
              </p>
              {receipt.invoiceReference && (
                <p className="break-words">
                  {t("inventory.receipts.invoice")} · {receipt.invoiceReference}
                </p>
              )}
              {receipt.notes && <p className="whitespace-pre-wrap break-words">{receipt.notes}</p>}
              {receipt.purchaseOrderId && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (receipt.purchaseOrderId) onOrder(receipt.purchaseOrderId);
                  }}
                >
                  {t("inventory.orders.linked")}
                </Button>
              )}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {receipt.lines.map((line) => (
                <li
                  key={line.productId}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <span className="break-words min-w-0">
                    <strong>{line.name}</strong>
                    <span className="block text-muted">{line.sku}</span>
                  </span>
                  <span className="tabular-nums">
                    {t("inventory.receipts.units", { count: line.quantity })}
                  </span>
                  {readCosts && line.unitCostCents != null && (
                    <span>{formatMoney(line.unitCostCents, "EUR", locale)}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("inventory.receipts.title")}</h3>
        {canWrite && userId && (
          <Button
            onClick={() => {
              setCreating(true);
              onEditingChange(true);
            }}
          >
            {t("inventory.receipts.new")}
          </Button>
        )}
      </div>
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {!list.isError && (
        <DataTable<Omit<StockReceipt, "lines">>
          label={t("inventory.receipts.title")}
          data={list.data?.receipts ?? []}
          columns={[
            {
              id: "number",
              header: t("inventory.receipts.title"),
              accessorFn: (row) => row.number,
              cell: ({ row }) => t("inventory.receipts.number", { number: row.original.number }),
              meta: { cardTitle: true },
              enableSorting: false,
            },
            {
              id: "date",
              header: t("inventory.receipts.date"),
              accessorFn: (row) => row.receivedOn,
              cell: ({ row }) => formatDateWithYear(row.original.receivedOn, locale),
              enableSorting: false,
            },
            {
              id: "supplier",
              header: t("inventory.receipts.supplier"),
              accessorFn: (row) => row.supplierName,
              cell: ({ row }) => row.original.supplierName ?? t("inventory.receipts.noSupplier"),
              enableSorting: false,
            },
            {
              id: "invoice",
              header: t("inventory.receipts.invoice"),
              accessorFn: (row) => row.invoiceReference,
              cell: ({ row }) => (
                <span className="break-all">{row.original.invoiceReference ?? "—"}</span>
              ),
              enableSorting: false,
            },
          ]}
          getRowId={(row) => row.id}
          total={list.data?.pagination.total ?? 0}
          page={page}
          pageSize={list.data?.pagination.pageSize ?? 20}
          onPageChange={onPageChange}
          onRowOpen={(row) => onPick(row.id)}
          sorting={[]}
          onSortingChange={() => {}}
          loading={list.isPending}
          empty={<p className="text-muted">{t("inventory.receipts.empty")}</p>}
        />
      )}
    </section>
  );
}

export function SupplierPickerPager({
  pagination,
  onChange,
}: {
  pagination: PageInfo;
  onChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const { page, total, pageSize } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page === 1 && pages === 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t("inventory.receipts.previous")}
      </Button>
      <span>{t("inventory.page", { page, pages })}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        {t("inventory.receipts.next")}
      </Button>
    </div>
  );
}

type ReceiptLine = { product: Product; quantity: string };
export function orderReceiptKey(userId: string, orderId: string) {
  return `citame:stock-receipt:${encodeURIComponent(userId)}:order:${orderId}`;
}

export function OrderReceiptEditor({
  order,
  userId,
  onClose,
  onSaved,
}: {
  order: PurchaseOrder;
  userId: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const review = useQuery({
    queryKey: ["inventory", "order-receipt-products", order.id, order.generation, order.version],
    queryFn: () => loadOrderProducts(order),
    enabled: online,
  });
  if (review.isError && !review.data)
    return (
      <div className="space-y-3">
        <ErrorState error={review.error} onRetry={() => void review.refetch()} />
        <Button onClick={onClose}>{t("inventory.orders.back")}</Button>
      </div>
    );
  if (!review.data)
    return (
      <div className="space-y-3">
        <p role="status">{t(online ? "admin.loading" : "problem.offline")}</p>
        <Button onClick={onClose}>{t("inventory.orders.back")}</Button>
      </div>
    );
  return (
    <ReceiptEditor
      userId={userId}
      onClose={onClose}
      onSaved={onSaved}
      initialOrder={order}
      initialLines={review.data}
    />
  );
}

async function loadOrderProducts(
  order: PurchaseOrder,
  input?: StockReceiptInput,
): Promise<ReceiptLine[]> {
  return Promise.all(
    order.lines
      .filter(
        (line) =>
          line.receivedQuantity < line.quantity ||
          input?.lines.some((row) => row.productId === line.productId),
      )
      .map(async (line) => ({
        product: await api().inventory.get(line.productId),
        quantity: String(
          input?.lines.find((row) => row.productId === line.productId)?.quantity ?? 0,
        ),
      })),
  );
}

function ReceiptEditor({
  userId,
  initialOrder,
  initialLines,
  onClose,
  onSaved,
}: {
  userId: string;
  initialOrder?: PurchaseOrder;
  initialLines?: ReceiptLine[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t, timeZone, locale } = useI18n();
  const cache = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const heading = useId();
  const today = localDateOf(new Date().toISOString(), timeZone);
  const [receivedOn, setReceivedOn] = useState(today);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [invoice, setInvoice] = useState("");
  const [notes, setNotes] = useState("");
  const [order, setOrder] = useState(initialOrder);
  const [lines, setLines] = useState<ReceiptLine[]>(initialLines ?? []);
  const [search, setSearch] = useState("");
  const productSearch = useDebounced(search.trim(), 200);
  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierPage, setSupplierPage] = useState(1);
  const supplierTerm = useDebounced(supplierSearch.trim(), 200);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "discard" | null>(null);
  const key = order
    ? orderReceiptKey(userId, order.id)
    : `citame:stock-receipt:${encodeURIComponent(userId)}`;
  const [saved, setSaved] = useState(() => {
    try {
      return {
        command: receiptRequests.read(key),
        failed: false,
      };
    } catch {
      return { command: null, failed: true };
    }
  });
  const busy = useRef(false);
  const products = useQuery({
    queryKey: ["inventory", "receipt-products", productSearch],
    queryFn: () => api().inventory.list({ search: productSearch, pageSize: 10 }),
    enabled: !order && productSearch.length > 0 && !saved.command && online,
  });
  const suppliers = useQuery({
    queryKey: ["inventory", "receipt-suppliers", supplierTerm, supplierPage],
    queryFn: () =>
      api().inventory.suppliers({ search: supplierTerm, active: true, page: supplierPage }),
    enabled: !order && !saved.command && online,
  });
  const pick = useMutation({
    mutationFn: (id: string) => api().inventory.get(id),
    onSuccess: (product) => {
      if (!product.active || !product.inventoryGeneration || !product.canManage) {
        setError(true);
        return;
      }
      setLines((current) =>
        current.length >= MAX_STOCK_RECEIPT_LINES ||
        current.some((line) => line.product.id === product.id)
          ? current
          : [...current, { product, quantity: "1" }],
      );
      setSearch("");
    },
  });
  const send = useMutation({
    mutationFn: (command: StockReceiptInput) => api().inventory.receive(command),
    onSuccess: async (receipt, command) => {
      await receiptRequests.clear(key, command);
      setSaved({ command: null, failed: false });
      toast.success(t("inventory.receipts.saved"));
      await cache.invalidateQueries({ queryKey: ["inventory"] });
      onSaved(receipt.id);
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  const review = useMutation({
    mutationFn: async (input: StockReceiptInput) => {
      if (input.purchaseOrder) {
        const latest = await api().inventory.order(input.purchaseOrder.id);
        if (latest.status !== "ordered" && latest.status !== "partially_received")
          throw new ApiError("version_conflict", 409, "This purchase order is closed");
        const products = await loadOrderProducts(latest, input);
        if (products.some(({ product }) => product.inventoryGeneration !== latest.generation))
          throw new ApiError("sync_generation_changed", 409, "The inventory generation changed");
        return { products, supplier: null, input, latest };
      }
      const [products, supplier] = await Promise.all([
        Promise.all(
          input.lines.map(async (line) => ({
            product: await api().inventory.get(line.productId),
            quantity: String(line.quantity),
          })),
        ),
        input.supplierId ? api().inventory.supplier(input.supplierId) : null,
      ]);
      const generation = products[0]?.product.inventoryGeneration;
      if (!generation || products.some(({ product }) => product.inventoryGeneration !== generation))
        throw new Error("The inventory generation changed");
      return { products, supplier, input, latest: undefined };
    },
    onSuccess: async ({ products, supplier, input, latest }) => {
      await receiptRequests.clear(key, input);
      setReceivedOn(input.receivedOn);
      setInvoice(input.invoiceReference ?? "");
      setNotes(input.notes ?? "");
      setLines(products);
      setSupplier(supplier);
      setOrder(latest);
      setSaved({ command: null, failed: false });
      send.reset();
    },
  });
  const dirty = !!(
    receivedOn !== today ||
    supplier ||
    invoice ||
    notes ||
    lines.some((line) => Number(line.quantity) > 0)
  );
  const remaining = new Map(
    order?.lines.map((line) => [line.productId, line.quantity - line.receivedQuantity]),
  );
  const canReceive = !order || order.status === "ordered" || order.status === "partially_received";
  const command = saved.command;
  const locked = send.isPending || !!command;
  const rejection =
    send.error instanceof ApiError && send.error.status === 409 ? send.error.code : null;
  const restored = rejection === "sync_generation_changed";
  const rejected = restored || rejection === "version_conflict";
  const working = send.isPending || review.isPending;
  return (
    <section className="space-y-4">
      <UnsavedGuard dirty={dirty && !command && !send.isPending} />
      <h3 id={heading} className="text-heading">
        {t(order ? "inventory.orders.receive" : "inventory.receipts.new")}
      </h3>
      <form
        aria-labelledby={heading}
        method="post"
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy.current || locked || saved.failed || !online) return;
          if (!canReceive) return;
          const included = order ? lines.filter((line) => Number(line.quantity) !== 0) : lines;
          const generation = order?.generation ?? included[0]?.product.inventoryGeneration;
          const payload = stockReceiptInputSchema.safeParse({
            receivedOn,
            supplierId: order?.supplierId ?? supplier?.id ?? null,
            ...(order ? { purchaseOrder: { id: order.id, version: order.version } } : {}),
            invoiceReference: invoice.trim() || null,
            notes: notes.trim() || null,
            actorUserId: userId,
            generation,
            idempotencyKey: crypto.randomUUID(),
            lines: included.map(({ product, quantity }) => ({
              productId: product.id,
              version: product.version,
              quantity: Number(quantity),
            })),
          });
          if (
            !payload.success ||
            supplier?.active === false ||
            included.some(
              ({ product, quantity }) =>
                (!order && !product.active) ||
                (order && Number(quantity) > (remaining.get(product.id) ?? 0)) ||
                product.inventoryGeneration !== generation ||
                product.stockOnHand + Number(quantity) > 999999999,
            )
          ) {
            setError(true);
            return;
          }
          busy.current = true;
          try {
            const pending = await receiptRequests.preserve(key, payload.data);
            setError(false);
            setSaved({ command: pending, failed: false });
            if (pending.idempotencyKey === payload.data.idempotencyKey) {
              send.mutate(pending);
            } else busy.current = false;
          } catch {
            busy.current = false;
            setSaved({ command: null, failed: true });
          }
        }}
      >
        {order && (
          <p className="text-muted break-words">
            {t("inventory.orders.number", { number: order.number })} · {order.supplierName}
          </p>
        )}
        {command ? (
          <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
            <p role="status">{t("inventory.receipts.pending")}</p>
            <p>
              {formatDateWithYear(command.receivedOn, locale)} ·{" "}
              {command.invoiceReference ?? t("inventory.receipts.noInvoice")} ·{" "}
              {t("inventory.receipts.lines", { count: command.lines.length })}
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                name="receivedOn"
                label={t("inventory.receipts.date")}
                type="date"
                max={today}
                required
                value={receivedOn}
                onChange={(event) => setReceivedOn(event.target.value)}
              />
              <TextField
                name="invoiceReference"
                label={t("inventory.receipts.invoice")}
                maxLength={100}
                value={invoice}
                onChange={(event) => setInvoice(event.target.value)}
              />
              {!order && (
                <>
                  <TextField
                    name="supplierSearch"
                    label={t("inventory.suppliers.search")}
                    value={supplierSearch}
                    maxLength={100}
                    onChange={(event) => {
                      setSupplierSearch(event.target.value);
                      setSupplierPage(1);
                    }}
                    className="min-w-0"
                  />
                  <SelectField
                    name="supplier"
                    label={t("inventory.receipts.supplier")}
                    value={supplier?.id ?? ""}
                    onChange={(value) =>
                      setSupplier(
                        suppliers.data?.suppliers.find((entry) => entry.id === value) ?? null,
                      )
                    }
                    options={[
                      { value: "", label: t("inventory.receipts.noSupplier") },
                      ...(supplier &&
                      !suppliers.data?.suppliers.some((option) => option.id === supplier.id)
                        ? [{ value: supplier.id, label: supplier.name, disabled: !supplier.active }]
                        : []),
                      ...(suppliers.data?.suppliers.map((option) => ({
                        value: option.id,
                        label: [option.name, option.taxId ?? option.email ?? option.phone]
                          .filter(Boolean)
                          .join(" · "),
                      })) ?? []),
                    ]}
                  />
                </>
              )}
            </div>
            {!order && suppliers.data && (
              <SupplierPickerPager
                pagination={suppliers.data.pagination}
                onChange={setSupplierPage}
              />
            )}
            {!order && suppliers.isError && (
              <ErrorState error={suppliers.error} onRetry={() => void suppliers.refetch()} />
            )}
            <TextAreaField
              name="notes"
              label={t("inventory.receipts.notes")}
              maxLength={1000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
            {!order && lines.length < MAX_STOCK_RECEIPT_LINES && (
              <TextField
                name="productSearch"
                label={t("inventory.search")}
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
            {products.isError && (
              <ErrorState error={products.error} onRetry={() => void products.refetch()} />
            )}
            {pick.isError && <ErrorState error={pick.error} />}
            {!order && productSearch && lines.length < MAX_STOCK_RECEIPT_LINES && (
              <SelectField
                label={t("inventory.receipts.addProduct")}
                name="productPick"
                value=""
                disabled={!online || pick.isPending || products.isPending}
                onChange={(value) => {
                  if (value) pick.mutate(value);
                }}
                options={[
                  { value: "", label: t("inventory.receipts.chooseProduct") },
                  ...(products.data?.products ?? [])
                    .filter((product) => !lines.some((line) => line.product.id === product.id))
                    .map((product) => ({
                      value: product.id,
                      label: `${product.name} · ${product.sku}`,
                    })),
                ]}
              />
            )}
            {lines.map((line) => (
              <fieldset
                key={line.product.id}
                className="min-w-0 rounded-xl border border-line bg-surface p-3 space-y-2"
              >
                <legend className="max-w-full break-all px-2 font-medium">
                  {line.product.name} · {line.product.sku}
                </legend>
                <p className="text-muted">
                  {t("inventory.onHand", { count: line.product.stockOnHand })}
                  {order && (
                    <>
                      {" "}
                      ·{" "}
                      {t("inventory.orders.remaining", {
                        count: remaining.get(line.product.id) ?? 0,
                      })}
                    </>
                  )}
                  {!line.product.active && <> · {t("inventory.inactive")}</>}
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <TextField
                    name={`quantity-${line.product.id}`}
                    label={t("inventory.quantity")}
                    inputMode="numeric"
                    pattern="[0-9]{1,9}"
                    required
                    value={line.quantity}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row) =>
                          row.product.id === line.product.id
                            ? { ...row, quantity: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                  {!order && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setLines((current) =>
                          current.filter((row) => row.product.id !== line.product.id),
                        )
                      }
                    >
                      {t("inventory.receipts.removeLine")}
                    </Button>
                  )}
                </div>
              </fieldset>
            ))}
          </>
        )}
        {error && <p role="alert">{t("inventory.receipts.invalid")}</p>}
        {saved.failed && <p role="alert">{t("inventory.movementStorage")}</p>}
        {send.isError && <ErrorState error={send.error} />}
        {restored && <p role="status">{t("inventory.receipts.restored")}</p>}
        {review.isError && <ErrorState error={review.error} />}
        <div className="flex flex-wrap items-center gap-2">
          {command ? (
            <>
              {rejected && (
                <Button
                  type="button"
                  disabled={!online || working}
                  onClick={() => review.mutate(command)}
                >
                  {t("inventory.movementReview")}
                </Button>
              )}
              <Button
                type="button"
                disabled={!online || working}
                onClick={() => {
                  if (busy.current || command.actorUserId !== userId) return;
                  busy.current = true;
                  send.mutate(command);
                }}
              >
                {t("inventory.receipts.retry")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={working}
                onClick={() => setConfirm("discard")}
              >
                {t("inventory.movementDiscard")}
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              disabled={!online || !canReceive || saved.failed || pick.isPending}
            >
              {t("inventory.receipts.save")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={working}
            onClick={() => (dirty && !command ? setConfirm("leave") : onClose())}
          >
            {t("inventory.receipts.back")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        destructive
        title={t("admin.unsaved.title")}
        description={t(
          confirm === "discard" ? "inventory.receipts.discardExplain" : "admin.unsaved.body",
        )}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={async () => {
          if (confirm === "discard" && command) {
            try {
              await receiptRequests.clear(key, command);
              setSaved({ command: null, failed: false });
              if (order) onClose();
              else setLines([]);
              send.reset();
            } catch {
              setSaved({ command, failed: true });
            }
          } else onClose();
          setConfirm(null);
        }}
      />
    </section>
  );
}
