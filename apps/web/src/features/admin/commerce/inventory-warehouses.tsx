import {
  type Product,
  type Warehouse,
  type WarehouseStock,
  warehouseInputSchema,
} from "@sob/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/ui/data-table";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { useInventoryLiveRevision } from "../calendar/live-provider";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import type { InventoryNavigation } from "./inventory-navigation";
import { type PendingTransfer, transferRequests } from "./inventory-requests";
import { StockAdjustment } from "./stock-adjustment";
import {
  reviewTransferStock,
  TransferEditor,
  type TransferReview,
} from "./warehouse-transfer-editor";

type Balance = WarehouseStock["products"][number];
type Adjustment = {
  product: Product;
  location?: { id: string; name: string; onHand: number; reserved: number };
};

export function InventoryWarehouses({
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
  const { t, locale, timeZone } = useI18n();
  const cache = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const liveRevision = useInventoryLiveRevision();
  const search = navigation.warehouseSearch ?? "";
  const page = navigation.inventoryPage ?? 1;
  const [warehouseDraft, setWarehouseDraft] = useState<Warehouse | "new" | null>(null);
  const [draft, setDraft] = useState(false);
  const [adjusting, setAdjusting] = useState<Adjustment | null>(null);
  const pendingKey = userId ? `citame:stock-transfer:${encodeURIComponent(userId)}` : null;
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [recovered, setRecovered] = useState<TransferReview | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [discardPending, setDiscardPending] = useState(false);
  const [storage, setStorage] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    if (!pendingKey || !canWrite) return;
    try {
      setPending(transferRequests.read(pendingKey));
      setStorage("ready");
    } catch {
      setStorage("failed");
    }
  }, [pendingKey, canWrite]);
  const editing = Boolean(warehouseDraft || draft || adjusting);
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);

  const warehouses = useQuery({
    queryKey: ["inventory", "warehouses", liveRevision],
    placeholderData: keepPreviousData,
    queryFn: () => api().inventory.warehouses(),
  });
  const id = navigation.warehouse ?? "main";
  const searchTerm = useDebounced(search.trim(), 200);
  const query = { warehouseId: id, search: searchTerm, page };
  const stock = useQuery({
    queryKey: ["inventory", "warehouse-stock", query, liveRevision],
    queryFn: () => api().inventory.warehouseStock(query),
    enabled: Boolean(warehouses.data && !navigation.transfer && !editing),
    placeholderData: (previous, request) => {
      const key = request?.queryKey[2] as typeof query | undefined;
      return key?.warehouseId === id && key.search === searchTerm && key.page === page
        ? previous
        : undefined;
    },
  });
  const transfer = useQuery({
    queryKey: ["inventory", "transfer", navigation.transfer],
    queryFn: () => api().inventory.transfer(navigation.transfer ?? ""),
    enabled: Boolean(navigation.transfer),
  });
  const open = useMutation({
    mutationFn: async (productId: string): Promise<Adjustment> => {
      const [product, balance] = await Promise.all([
        api().inventory.get(productId),
        id === "main" ? null : api().inventory.warehouseStock({ warehouseId: id, productId }),
      ]);
      if (!balance) return { product };
      const row = balance.products[0];
      if (
        !row ||
        !balance.warehouse.active ||
        balance.generation !== product.inventoryGeneration ||
        row.version !== product.version
      )
        throw new Error("Stock changed during review");
      return {
        product,
        location: {
          id,
          name: balance.warehouse.name ?? "",
          onHand: row.onHand,
          reserved: row.reserved,
        },
      };
    },
    onSuccess: (reviewed) => setAdjusting(reviewed),
  });
  const send = useMutation({
    mutationFn: async (candidate: PendingTransfer) => {
      if (!pendingKey || !canWrite) throw new Error("Transfer storage is unavailable");
      let request: PendingTransfer;
      try {
        request = await transferRequests.preserve(
          pendingKey,
          candidate,
          recovered ? pending?.id : undefined,
        );
      } catch (error) {
        setStorage("failed");
        throw error;
      }
      if (request.id !== candidate.id) {
        setPending(request);
        setRecovered(null);
        return null;
      }
      try {
        const result = await api().inventory.saveTransfer(request.id, request.command);
        await transferRequests.clear(pendingKey, request);
        setPending(null);
        return result;
      } catch (error) {
        setPending(request);
        setRecovered(null);
        setReviewRequired(error instanceof ApiError && [400, 404, 409, 422].includes(error.status));
        throw error;
      }
    },
    onSuccess: (result) => {
      if (!result) return;
      setDraft(false);
      setRecovered(null);
      setReviewRequired(false);
      cache.setQueryData(["inventory", "transfer", result.id], result);
      void cache.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(t("inventory.warehouse.savedTransfer"));
      onNavigation({ ...navigation, transfer: result.id });
    },
  });
  const recover = useMutation({
    mutationFn: async (request: PendingTransfer) => {
      try {
        const saved = await api().inventory.transfer(request.id);
        return { saved } as const;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      const { command } = request;
      const source = command.sourceId ?? "main";
      const reviewed = await reviewTransferStock(
        source,
        command.lines.map((line) => ({
          productId: line.productId,
          quantity: String(line.quantity),
        })),
      );
      if (!reviewed.generation) throw new Error("The current transfer stock could not be reviewed");
      return {
        draft: {
          source,
          destination: command.destinationId ?? "main",
          reason: command.reason,
          lines: reviewed.lines,
          generation: reviewed.generation,
        },
      } as const;
    },
    onSuccess: async (result, request) => {
      if ("saved" in result && result.saved && pendingKey) {
        await transferRequests.clear(pendingKey, request);
        setPending(null);
        setDraft(false);
        setReviewRequired(false);
        onNavigation({ ...navigation, transfer: result.saved.id });
        return;
      }
      if (result.draft) {
        setRecovered(result.draft);
        setDraft(true);
        setReviewRequired(false);
        send.reset();
      }
    },
  });
  const discard = useMutation({
    mutationFn: async (request: PendingTransfer) => {
      if (pendingKey) await transferRequests.clear(pendingKey, request);
    },
    onSuccess: () => {
      setPending(null);
      setRecovered(null);
      setDraft(false);
      setReviewRequired(false);
      send.reset();
    },
  });
  const labels = (warehouse: Warehouse) =>
    (warehouse.name ?? t("inventory.warehouse.main")) +
    (warehouse.active ? "" : ` · ${t("inventory.inactive")}`);
  const locationOptions =
    warehouses.data?.warehouses.map((warehouse) => ({
      value: warehouse.id ?? "main",
      label: labels(warehouse),
    })) ?? [];
  const current = warehouses.data?.warehouses.find((warehouse) => (warehouse.id ?? "main") === id);
  const ready = canWrite && Boolean(userId) && online;
  const back = () => {
    setWarehouseDraft(null);
    setDraft(false);
    setRecovered(null);
    setAdjusting(null);
    send.reset();
  };
  const sendError = send.isError && <ErrorState error={send.error} />;

  if (pending && !recovered && canWrite)
    return (
      <section className="space-y-3">
        <h3 className="text-heading">{t("inventory.warehouse.transfer")}</h3>
        <p role="status">{t("inventory.warehouse.pending")}</p>
        <p className="break-words">{pending.command.reason}</p>
        {sendError}
        {recover.isError && <ErrorState error={recover.error} />}
        {discard.isError && <ErrorState error={discard.error} />}
        <div className="flex flex-wrap gap-2">
          {reviewRequired && (
            <Button
              disabled={!ready || recover.isPending || send.isPending}
              onClick={() => recover.mutate(pending)}
            >
              {t("inventory.warehouse.reload")}
            </Button>
          )}
          <Button
            disabled={!ready || send.isPending || recover.isPending}
            onClick={() => send.mutate(pending)}
          >
            {t("inventory.warehouse.retry")}
          </Button>
          {reviewRequired && (
            <Button
              variant="secondary"
              disabled={send.isPending || recover.isPending || discard.isPending}
              onClick={() => setDiscardPending(true)}
            >
              {t("inventory.movementDiscard")}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={send.isPending}
            onClick={() => {
              back();
              onNavigation({ inventoryTab: "products" });
            }}
          >
            {t("inventory.warehouse.back")}
          </Button>
        </div>
        <ConfirmDialog
          open={discardPending}
          onOpenChange={setDiscardPending}
          destructive
          title={t("inventory.movementDiscard")}
          description={t("admin.unsaved.body")}
          confirmLabel={t("admin.unsaved.leave")}
          cancelLabel={t("admin.unsaved.stay")}
          onConfirm={() => {
            setDiscardPending(false);
            discard.mutate(pending);
          }}
        />
      </section>
    );
  if (warehouseDraft && canWrite && warehouses.data)
    return (
      <WarehouseEditor
        warehouse={warehouseDraft}
        generation={warehouses.data.generation}
        onClose={back}
        onSaved={(warehouse) => {
          back();
          onNavigation({ inventoryTab: "warehouses", warehouse: warehouse ?? undefined });
        }}
      />
    );
  if (draft && canWrite && warehouses.data)
    return (
      <TransferEditor
        warehouses={warehouses.data.warehouses.filter((row) => row.active)}
        generation={warehouses.data.generation}
        initialSource={id}
        recovered={recovered ?? undefined}
        busy={send.isPending}
        writable={ready && storage === "ready"}
        error={sendError}
        onClose={back}
        onSave={(command) => send.mutate({ id: crypto.randomUUID(), command })}
      />
    );
  if (adjusting && canWrite) {
    const { product, location } = adjusting;
    return (
      <section className="space-y-3">
        <Button variant="ghost" onClick={back}>
          {t("inventory.warehouse.back")}
        </Button>
        <h3 className="text-heading break-words">{product.name}</h3>
        {open.isError && <ErrorState error={open.error} onRetry={() => open.mutate(product.id)} />}
        {open.isPending ? (
          <p role="status">{t("admin.loading")}</p>
        ) : (
          <StockAdjustment
            key={`${product.id}:${id}`}
            product={product}
            userId={userId}
            location={location}
            onSaved={() => {
              open.mutate(product.id);
              void cache.invalidateQueries({ queryKey: ["inventory"] });
            }}
          />
        )}
      </section>
    );
  }
  if (navigation.transfer) {
    const record = transfer.data;
    return (
      <section className="space-y-3">
        <Button
          variant="ghost"
          onClick={() => onNavigation({ ...navigation, transfer: undefined })}
        >
          {t("inventory.warehouse.back")}
        </Button>
        {transfer.isError && (
          <ErrorState error={transfer.error} onRetry={() => void transfer.refetch()} />
        )}
        {transfer.isPending && <p role="status">{t("admin.loading")}</p>}
        {record && (
          <>
            <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
              <h3 className="text-heading">{t("inventory.warehouse.transfer")}</h3>
              <p className="break-words">
                {record.sourceName ?? t("inventory.warehouse.main")} →{" "}
                {record.destinationName ?? t("inventory.warehouse.main")}
              </p>
              <p className="break-words">{record.reason}</p>
              <p className="text-muted">
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone,
                }).format(new Date(record.createdAt))}
              </p>
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {record.lines.map((line) => (
                <li
                  key={line.productId}
                  className="flex flex-wrap justify-between gap-2 p-4 break-words"
                >
                  <span>
                    {line.name} · {line.sku}
                  </span>
                  <strong className="tabular-nums">{line.quantity}</strong>
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-heading">{t("inventory.warehouse.title")}</h3>
        {ready && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!warehouses.data}
              onClick={() => setWarehouseDraft("new")}
            >
              {t("inventory.warehouse.new")}
            </Button>
            {current?.id && (
              <Button variant="secondary" onClick={() => setWarehouseDraft(current)}>
                {t("inventory.warehouse.edit")}
              </Button>
            )}
            <Button
              disabled={
                storage !== "ready" ||
                !current?.active ||
                (warehouses.data?.warehouses.filter((row) => row.active).length ?? 0) < 2
              }
              onClick={() => {
                send.reset();
                setDraft(true);
              }}
            >
              {t("inventory.warehouse.newTransfer")}
            </Button>
          </div>
        )}
      </div>
      {storage === "failed" && <p role="alert">{t("inventory.movementStorage")}</p>}
      {warehouses.isError && (
        <ErrorState error={warehouses.error} onRetry={() => void warehouses.refetch()} />
      )}
      <search className="flex flex-wrap items-end gap-3">
        <SelectField
          name="warehouse"
          label={t("inventory.warehouse.location")}
          value={id}
          disabled={open.isPending}
          options={locationOptions}
          onChange={(value) => {
            onNavigation({
              inventoryTab: "warehouses",
              warehouse: value === "main" ? undefined : value,
            });
          }}
        />
        <TextField
          name="search"
          label={t("inventory.search")}
          value={search}
          maxLength={100}
          onChange={(event) => {
            onNavigation(
              { ...navigation, warehouseSearch: event.target.value, inventoryPage: undefined },
              true,
            );
          }}
        />
      </search>
      {ready && current?.active && id !== "main" && (
        <AdjustmentPicker onPick={(productId) => open.mutate(productId)} loading={open.isPending} />
      )}
      {open.isError && <ErrorState error={open.error} />}
      {stock.isError ? (
        <ErrorState error={stock.error} onRetry={() => void stock.refetch()} />
      ) : (
        <DataTable<Balance>
          label={t("inventory.warehouse.title")}
          data={stock.data?.products ?? []}
          getRowId={(row) => row.productId}
          columns={[
            {
              accessorKey: "name",
              header: t("inventory.name"),
              enableSorting: false,
              meta: { cardTitle: true },
            },
            { accessorKey: "sku", header: t("inventory.sku"), enableSorting: false },
            {
              accessorKey: "onHand",
              header: t("inventory.report.onHand"),
              enableSorting: false,
              meta: { numeric: true },
            },
            {
              accessorKey: "reserved",
              header: t("inventory.report.reserved"),
              enableSorting: false,
              meta: { numeric: true },
            },
          ]}
          page={page}
          pageSize={stock.data?.pagination.pageSize ?? 20}
          total={stock.data?.pagination.total ?? 0}
          sorting={[]}
          onSortingChange={() => {}}
          onPageChange={(inventoryPage) => onNavigation({ ...navigation, inventoryPage })}
          loading={stock.isPending}
          onRowOpen={
            ready && current?.active && !open.isPending
              ? (row) => open.mutate(row.productId)
              : undefined
          }
          empty={<p className="text-muted">{t("inventory.warehouse.empty")}</p>}
        />
      )}
    </section>
  );
}

function AdjustmentPicker({ onPick, loading }: { onPick: (id: string) => void; loading: boolean }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 200);
  const products = useQuery({
    queryKey: ["inventory", "warehouse-adjust-products", term],
    queryFn: () => api().inventory.list({ active: "all", search: term, pageSize: 15 }),
    enabled: term.length > 0,
  });
  return (
    <div className="space-y-2">
      <TextField
        name="adjustSearch"
        label={t("inventory.warehouse.chooseProduct")}
        value={search}
        maxLength={100}
        onChange={(event) => setSearch(event.target.value)}
      />
      {products.isError && (
        <ErrorState error={products.error} onRetry={() => void products.refetch()} />
      )}
      {term && (
        <SelectField
          name="adjustProduct"
          label={t("inventory.warehouse.adjust")}
          value=""
          disabled={loading || !products.data}
          options={[
            { value: "", label: t("inventory.receipts.chooseProduct") },
            ...(products.data?.products.map((row) => ({
              value: row.id,
              label: `${row.name} · ${row.sku}`,
            })) ?? []),
          ]}
          onChange={(id) => {
            if (id) onPick(id);
          }}
        />
      )}
    </div>
  );
}

function WarehouseEditor({
  warehouse: initial,
  generation,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse | "new";
  generation: string;
  onClose: () => void;
  onSaved: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const cache = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const heading = useId();
  const [reviewedGeneration] = useState(generation);
  const [id] = useState(() => (initial === "new" ? crypto.randomUUID() : initial.id));
  const [name, setName] = useState(initial === "new" ? "" : (initial.name ?? ""));
  const [active, setActive] = useState(initial === "new" || initial.active);
  const [dialog, setDialog] = useState<"archive" | "leave" | null>(null);
  const dirty =
    initial === "new" ? Boolean(name) : name !== initial.name || active !== initial.active;
  const save = useMutation({
    mutationFn: () => {
      if (!id) throw new Error("The main warehouse cannot be edited");
      const input = warehouseInputSchema.parse({
        name,
        active,
        generation: reviewedGeneration,
        version: initial === "new" ? 0 : initial.version,
      });
      return api().inventory.saveWarehouse(id, input);
    },
    onSuccess: (warehouse) => {
      void cache.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(t("inventory.warehouse.saved"));
      onSaved(warehouse.id);
    },
  });
  return (
    <section className="space-y-4">
      <UnsavedGuard dirty={dirty && !save.isPending} />
      <h3 id={heading} className="text-heading">
        {t(initial === "new" ? "inventory.warehouse.new" : "inventory.warehouse.edit")}
      </h3>
      <form
        method="post"
        aria-labelledby={heading}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || !name.trim() || save.isPending) return;
          if (initial !== "new" && initial.active && !active) setDialog("archive");
          else save.mutate();
        }}
      >
        <TextField
          name="name"
          label={t("inventory.warehouse.name")}
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {initial !== "new" && (
          <label className="flex w-fit items-center gap-2">
            <input
              type="checkbox"
              name="active"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />
            {t("inventory.active")}
          </label>
        )}
        {!active && <p className="text-muted">{t("inventory.warehouse.archiveHelp")}</p>}
        {save.isError && <ErrorState error={save.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!online || !dirty || save.isPending}>
            {t("inventory.warehouse.save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => (dirty ? setDialog("leave") : onClose())}
          >
            {t("inventory.warehouse.back")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        destructive
        title={t(dialog === "archive" ? "inventory.warehouse.archive" : "admin.unsaved.title")}
        description={t(
          dialog === "archive" ? "inventory.warehouse.archiveHelp" : "admin.unsaved.body",
        )}
        confirmLabel={t(
          dialog === "archive" ? "inventory.warehouse.archive" : "admin.unsaved.leave",
        )}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={() => {
          if (dialog === "archive") save.mutate();
          else onClose();
          setDialog(null);
        }}
      />
    </section>
  );
}
