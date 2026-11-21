import {
  MAX_PURCHASE_ORDER_LINES,
  type PurchaseOrder,
  type PurchaseOrderCommand,
  type PurchaseOrderSummary,
  purchaseOrderCommandSchema,
  purchaseOrderStatusSchema,
} from "@sob/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
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
import { formatDateWithYear } from "~/lib/format";
import { useInventoryLiveRevision } from "../calendar/live-provider";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import type { InventoryNavigation } from "./inventory-navigation";
import { OrderReceiptEditor, orderReceiptKey, SupplierPickerPager } from "./inventory-receipts";
import { orderRequests, type PendingOrder, receiptRequests } from "./inventory-requests";

type Editor = { id: string; generation: string; order?: PurchaseOrder };
const statuses = purchaseOrderStatusSchema.options;
const orderActions = ["order", "cancel"] as const;

function pendingReceipt(userId: string, orderId: string) {
  try {
    return Boolean(receiptRequests.read(orderReceiptKey(userId, orderId)));
  } catch {
    return true;
  }
}

export function InventoryOrders({
  canWrite,
  userId,
  navigation,
  onNavigation,
  onEditingChange,
}: {
  canWrite: boolean;
  userId?: string;
  navigation: InventoryNavigation;
  onNavigation: (navigation: InventoryNavigation, replace?: boolean) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const cache = useQueryClient();
  const liveRevision = useInventoryLiveRevision();
  const toast = useToast();
  const online = useOnline();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [receive, setReceive] = useState<PurchaseOrder | null>(null);
  const [confirm, setConfirm] = useState<{
    order: PurchaseOrder;
    action: (typeof orderActions)[number];
  } | null>(null);
  const storageKey = userId ? `citame:purchase-order:${encodeURIComponent(userId)}` : null;
  const [request, setRequest] = useState<{ pending: PendingOrder | null; failed: boolean }>({
    pending: null,
    failed: false,
  });
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    try {
      setRequest({
        pending: canWrite && storageKey ? orderRequests.read(storageKey) : null,
        failed: false,
      });
    } catch {
      setRequest({ pending: null, failed: true });
    }
    setStorageReady(true);
  }, [canWrite, storageKey]);
  const orderId = navigation.order;
  const search = navigation.orderSearch ?? "";
  const term = useDebounced(search.trim(), 200);
  const page = navigation.inventoryPage ?? 1;
  const query = { search: term, status: navigation.orderStatus, page };
  const list = useQuery({
    queryKey: ["inventory", "orders", query, liveRevision],
    queryFn: () => api().inventory.orders(query),
    enabled: !orderId,
  });
  const detail = useQuery({
    queryKey: ["inventory", "order", orderId, liveRevision],
    placeholderData: keepPreviousData,
    queryFn: () => api().inventory.order(orderId ?? ""),
    enabled: Boolean(orderId),
  });
  const working = Boolean(editor || receive || request.pending);
  useEffect(() => {
    onEditingChange(working);
    return () => onEditingChange(false);
  }, [working, onEditingChange]);

  const send = useMutation({
    mutationFn: async (candidate: PendingOrder) => {
      if (!storageKey || !canWrite) throw new Error("Purchase order storage is unavailable");
      let pending: PendingOrder;
      try {
        pending = await orderRequests.preserve(storageKey, candidate);
      } catch (error) {
        setRequest((current) => ({ ...current, failed: true }));
        throw error;
      }
      if (pending.command.idempotencyKey !== candidate.command.idempotencyKey) {
        setRequest({ pending, failed: false });
        return null;
      }
      const clearRequest = async () => {
        await orderRequests.clear(storageKey, pending);
        setRequest({ pending: null, failed: false });
      };
      try {
        const saved = await api().inventory.saveOrder(pending.id, pending.command);
        await clearRequest();
        return saved;
      } catch (error) {
        if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status))
          await clearRequest();
        else setRequest({ pending, failed: false });
        throw error;
      }
    },
    onSuccess: (saved) => {
      if (!saved) return;
      setEditor(null);
      cache.setQueryData(["inventory", "order", saved.id, liveRevision], saved);
      void cache.invalidateQueries({ queryKey: ["inventory"] });
      onNavigation({ ...navigation, order: saved.id });
      toast.success(t("inventory.orders.saved"));
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ["inventory", "order", orderId] });
    },
  });
  const outstanding = request.pending;
  const sendError = send.isError && <ErrorState error={send.error} />;
  const order = detail.isError || detail.data?.id !== orderId ? undefined : detail.data;
  const writable =
    canWrite && Boolean(userId) && online && storageReady && !request.failed && !send.isPending;
  const reviewReady = writable && !detail.isPlaceholderData;
  if (receive && canWrite && userId)
    return (
      <OrderReceiptEditor
        order={receive}
        userId={userId}
        onClose={() => setReceive(null)}
        onSaved={(id) => {
          setReceive(null);
          onNavigation({ inventoryTab: "receipts", receipt: id });
        }}
      />
    );
  if (outstanding || request.failed)
    return (
      <section className="space-y-3">
        {request.failed && <p role="alert">{t("inventory.movementStorage")}</p>}
        {outstanding && (
          <>
            <p role="status">{t("inventory.orders.pending")}</p>
            {sendError}
            <Button disabled={!writable} onClick={() => send.mutate(outstanding)}>
              {t("inventory.orders.retry")}
            </Button>
          </>
        )}
      </section>
    );
  if (editor && canWrite)
    return (
      <OrderEditor
        editor={editor}
        online={reviewReady}
        busy={send.isPending}
        latest={order}
        error={sendError}
        onClose={() => {
          setEditor(null);
          send.reset();
        }}
        onSave={(command) => send.mutate({ id: editor.id, command })}
      />
    );

  if (orderId) {
    const isOpen = order?.status === "ordered" || order?.status === "partially_received";
    return (
      <section className="space-y-4">
        <Button
          variant="ghost"
          disabled={send.isPending}
          onClick={() => {
            send.reset();
            onNavigation({ ...navigation, order: undefined });
          }}
        >
          {t("inventory.orders.back")}
        </Button>
        {detail.isError && (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        )}
        {detail.isPending && <p role="status">{t("admin.loading")}</p>}
        {order && (
          <>
            <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
              <h3 className="text-heading">
                {t("inventory.orders.number", { number: order.number })}
              </h3>
              <p className="break-words">
                {order.supplierName} · {t(`inventory.orders.status.${order.status}`)}
              </p>
              {order.supplierReference && (
                <p className="break-words">
                  {t("inventory.orders.reference")} · {order.supplierReference}
                </p>
              )}
              {order.expectedOn && (
                <p>
                  {t("inventory.orders.expected")} · {formatDateWithYear(order.expectedOn, locale)}
                </p>
              )}
              {order.notes && <p className="whitespace-pre-wrap break-words">{order.notes}</p>}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {order.lines.map((line) => (
                <li key={line.productId} className="space-y-1 p-4 break-words">
                  <strong>{line.name}</strong> <span className="text-muted">{line.sku}</span>
                  <p className="text-muted tabular-nums">
                    {t("inventory.orders.requested", { count: line.quantity })} ·{" "}
                    {t("inventory.orders.received", { count: line.receivedQuantity })}
                    {order.status !== "cancelled" && (
                      <>
                        {" "}
                        ·{" "}
                        {t("inventory.orders.remaining", {
                          count: line.quantity - line.receivedQuantity,
                        })}
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            {order.receipts.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-semibold">{t("inventory.receipts.title")}</h4>
                <ul className="flex flex-wrap gap-2">
                  {order.receipts.map((receipt) => (
                    <li key={receipt.id}>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          onNavigation({ inventoryTab: "receipts", receipt: receipt.id })
                        }
                      >
                        {t("inventory.receipts.number", { number: receipt.number })} ·{" "}
                        {formatDateWithYear(receipt.receivedOn, locale)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canWrite && userId && (
              <div className="flex flex-wrap gap-2">
                {order.status === "draft" && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={!reviewReady}
                      onClick={() => {
                        send.reset();
                        setEditor({ id: order.id, generation: order.generation, order });
                      }}
                    >
                      {t("inventory.orders.edit")}
                    </Button>
                    <Button
                      disabled={!reviewReady}
                      onClick={() => setConfirm({ order, action: "order" })}
                    >
                      {t("inventory.orders.place")}
                    </Button>
                  </>
                )}
                {(isOpen || (storageReady && pendingReceipt(userId, order.id))) && (
                  <Button disabled={!reviewReady} onClick={() => setReceive(order)}>
                    {t(isOpen ? "inventory.orders.receive" : "inventory.orders.reviewReceipt")}
                  </Button>
                )}
                {(isOpen || order.status === "draft") && (
                  <Button
                    variant="secondary"
                    disabled={!reviewReady}
                    onClick={() => setConfirm({ order, action: "cancel" })}
                  >
                    {t("inventory.orders.cancel")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {sendError}
        <ConfirmDialog
          open={Boolean(confirm)}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          destructive={confirm?.action === "cancel"}
          title={t(
            confirm?.action === "cancel" ? "inventory.orders.cancel" : "inventory.orders.place",
          )}
          description={t(
            confirm?.action === "cancel"
              ? "inventory.orders.cancelConfirm"
              : "inventory.orders.placeConfirm",
          )}
          confirmLabel={t(
            confirm?.action === "cancel" ? "inventory.orders.cancel" : "inventory.orders.place",
          )}
          cancelLabel={t("admin.unsaved.stay")}
          onConfirm={() => {
            if (confirm && reviewReady)
              send.mutate({
                id: confirm.order.id,
                command: {
                  action: confirm.action,
                  version: confirm.order.version,
                  generation: confirm.order.generation,
                  idempotencyKey: crypto.randomUUID(),
                },
              });
            setConfirm(null);
          }}
        />
      </section>
    );
  }

  const data = list.isError ? undefined : list.data;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("inventory.orders.title")}</h3>
        {canWrite && (
          <Button
            disabled={!writable || !data}
            onClick={() => {
              if (data) setEditor({ id: crypto.randomUUID(), generation: data.generation });
            }}
          >
            {t("inventory.orders.new")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("inventory.orders.search")}
          maxLength={100}
          value={search}
          onChange={(event) =>
            onNavigation({ ...navigation, orderSearch: event.target.value, inventoryPage: 1 }, true)
          }
        />
        <SelectField
          label={t("inventory.orders.status")}
          value={navigation.orderStatus ?? ""}
          options={[
            { value: "", label: t("inventory.orders.all") },
            ...statuses.map((value) => ({ value, label: t(`inventory.orders.status.${value}`) })),
          ]}
          onChange={(value) =>
            onNavigation(
              {
                ...navigation,
                inventoryPage: 1,
                orderStatus: purchaseOrderStatusSchema.safeParse(value).data,
              },
              true,
            )
          }
        />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable<PurchaseOrderSummary>
          label={t("inventory.orders.title")}
          data={data?.orders ?? []}
          columns={[
            {
              id: "number",
              header: t("inventory.orders.title"),
              accessorFn: (row) => row.number,
              cell: ({ row }) => t("inventory.orders.number", { number: row.original.number }),
              meta: { cardTitle: true },
              enableSorting: false,
            },
            {
              id: "supplier",
              header: t("inventory.receipts.supplier"),
              accessorFn: (row) => row.supplierName,
              enableSorting: false,
            },
            {
              id: "status",
              header: t("inventory.orders.status"),
              accessorFn: (row) => row.status,
              cell: ({ row }) => t(`inventory.orders.status.${row.original.status}`),
              enableSorting: false,
            },
            {
              id: "expected",
              header: t("inventory.orders.expected"),
              accessorFn: (row) => row.expectedOn,
              cell: ({ row }) =>
                row.original.expectedOn ? formatDateWithYear(row.original.expectedOn, locale) : "—",
              enableSorting: false,
            },
          ]}
          getRowId={(row) => row.id}
          total={data?.pagination.total ?? 0}
          page={page}
          pageSize={data?.pagination.pageSize ?? 20}
          onPageChange={(inventoryPage) => onNavigation({ ...navigation, inventoryPage })}
          onRowOpen={(row) => onNavigation({ ...navigation, order: row.id })}
          sorting={[]}
          onSortingChange={() => {}}
          empty={<p className="text-muted">{t("inventory.orders.empty")}</p>}
          loading={list.isPending}
        />
      )}
    </section>
  );
}

type DraftLine = Pick<PurchaseOrder["lines"][number], "productId" | "name" | "sku"> & {
  quantity: string;
};

function OrderEditor({
  editor,
  online,
  busy,
  latest,
  error,
  onClose,
  onSave,
}: {
  editor: Editor;
  online: boolean;
  busy: boolean;
  latest?: PurchaseOrder;
  error: ReactNode;
  onClose: () => void;
  onSave: (command: PurchaseOrderCommand) => void;
}) {
  const { t } = useI18n();
  const heading = useId();
  const initial = editor.order;
  const [supplier, setSupplier] = useState(
    initial ? { id: initial.supplierId, name: initial.supplierName } : null,
  );
  const [lines, setLines] = useState<DraftLine[]>(
    initial?.lines.map((line) => ({ ...line, quantity: String(line.quantity) })) ?? [],
  );
  const [reference, setReference] = useState(initial?.supplierReference ?? "");
  const [expected, setExpected] = useState(initial?.expectedOn ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierPage, setSupplierPage] = useState(1);
  const [productSearch, setProductSearch] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const supplierTerm = useDebounced(supplierSearch.trim(), 200);
  const productTerm = useDebounced(productSearch.trim(), 200);
  const suppliers = useQuery({
    queryKey: ["inventory", "order-suppliers", supplierTerm, supplierPage],
    queryFn: () =>
      api().inventory.suppliers({ active: true, search: supplierTerm, page: supplierPage }),
    enabled: online || busy,
  });
  const products = useQuery({
    queryKey: ["inventory", "order-products", productTerm],
    queryFn: () => api().inventory.list({ search: productTerm, active: "active", pageSize: 15 }),
    enabled: Boolean(productTerm) && (online || busy),
  });
  const stale =
    initial &&
    latest &&
    (latest.version !== initial.version || latest.generation !== editor.generation);
  return (
    <section className="space-y-4">
      <UnsavedGuard dirty={dirty && !busy} />
      <h3 id={heading} className="text-heading">
        {t(initial ? "inventory.orders.edit" : "inventory.orders.new")}
      </h3>
      <form
        aria-labelledby={heading}
        className="space-y-4"
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || busy || stale) return;
          const command = purchaseOrderCommandSchema.safeParse({
            action: "save",
            generation: editor.generation,
            version: initial?.version ?? 0,
            idempotencyKey: crypto.randomUUID(),
            supplierId: supplier?.id,
            supplierReference: reference.trim() || null,
            expectedOn: expected || null,
            notes: notes.trim() || null,
            lines: lines.map((line) => ({
              productId: line.productId,
              quantity: Number(line.quantity),
            })),
          });
          setInvalid(!command.success);
          if (command.success) onSave(command.data);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("inventory.suppliers.search")}
            value={supplierSearch}
            maxLength={100}
            onChange={(event) => {
              setSupplierSearch(event.target.value);
              setSupplierPage(1);
            }}
          />
          <SelectField
            required
            className="min-w-0"
            label={t("inventory.receipts.supplier")}
            value={supplier?.id ?? ""}
            options={[
              { value: "", label: t("inventory.orders.chooseSupplier") },
              ...(supplier && !suppliers.data?.suppliers.some((item) => item.id === supplier.id)
                ? [{ value: supplier.id, label: supplier.name }]
                : []),
              ...(suppliers.data?.suppliers.map((item) => ({
                value: item.id,
                label: [item.name, item.taxId ?? item.email ?? item.phone]
                  .filter(Boolean)
                  .join(" · "),
              })) ?? []),
            ]}
            onChange={(value) =>
              setSupplier(suppliers.data?.suppliers.find((item) => item.id === value) ?? null)
            }
          />
          <TextField
            label={t("inventory.orders.reference")}
            value={reference}
            maxLength={100}
            onChange={(event) => setReference(event.target.value)}
          />
          <TextField
            label={t("inventory.orders.expected")}
            type="date"
            value={expected}
            onChange={(event) => setExpected(event.target.value)}
          />
        </div>
        {suppliers.data && (
          <SupplierPickerPager pagination={suppliers.data.pagination} onChange={setSupplierPage} />
        )}
        {suppliers.isError && (
          <ErrorState error={suppliers.error} onRetry={() => void suppliers.refetch()} />
        )}
        <TextAreaField
          label={t("inventory.receipts.notes")}
          value={notes}
          maxLength={1000}
          onChange={(event) => setNotes(event.target.value)}
        />
        {lines.length < MAX_PURCHASE_ORDER_LINES && (
          <>
            <TextField
              label={t("inventory.search")}
              value={productSearch}
              maxLength={100}
              onChange={(event) => setProductSearch(event.target.value)}
            />
            {productTerm && (
              <SelectField
                label={t("inventory.receipts.addProduct")}
                value=""
                className="min-w-0"
                disabled={!products.data || products.isError}
                options={[
                  { value: "", label: t("inventory.receipts.chooseProduct") },
                  ...(products.data?.products ?? [])
                    .filter((item) => !lines.some((line) => line.productId === item.id))
                    .map((item) => ({ value: item.id, label: `${item.name} · ${item.sku}` })),
                ]}
                onChange={(value) => {
                  const product = products.data?.products.find((item) => item.id === value);
                  if (product) {
                    setLines((current) => [
                      ...current,
                      {
                        productId: product.id,
                        name: product.name,
                        sku: product.sku,
                        quantity: "1",
                      },
                    ]);
                    setProductSearch("");
                  }
                }}
              />
            )}
            {products.isError && (
              <ErrorState error={products.error} onRetry={() => void products.refetch()} />
            )}
          </>
        )}
        {lines.map((line) => (
          <fieldset
            key={line.productId}
            className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-3"
          >
            <legend className="max-w-full break-all px-2 font-medium">
              {line.name} · {line.sku}
            </legend>
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label={t("inventory.quantity")}
                inputMode="numeric"
                pattern="[1-9][0-9]{0,8}"
                required
                value={line.quantity}
                onChange={(event) =>
                  setLines((current) =>
                    current.map((item) =>
                      item.productId === line.productId
                        ? { ...item, quantity: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setLines((current) =>
                    current.filter((item) => item.productId !== line.productId),
                  );
                  setDirty(true);
                }}
              >
                {t("inventory.receipts.removeLine")}
              </Button>
            </div>
          </fieldset>
        ))}
        {invalid && <p role="alert">{t("inventory.orders.invalid")}</p>}
        {stale && <p role="alert">{t("inventory.orders.stale")}</p>}
        {error}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!online || busy || Boolean(stale)}>
            {t("inventory.orders.save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => (dirty ? setLeave(true) : onClose())}
          >
            {t("inventory.orders.back")}
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
