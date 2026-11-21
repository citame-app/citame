import type { Supplier, SupplierInput } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/ui/data-table";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import type { InventoryNavigation } from "./inventory-navigation";

export function InventorySuppliers({
  onEditingChange,
  navigation,
  onNavigation,
}: {
  onEditingChange: (editing: boolean) => void;
  navigation: InventoryNavigation;
  onNavigation: (navigation: InventoryNavigation, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const search = navigation.supplierSearch ?? "";
  const status = navigation.supplierStatus ?? "all";
  const page = navigation.inventoryPage ?? 1;
  const [selected, setSelected] = useState<{ supplier: Supplier; generation: string } | null>(null);
  useEffect(() => () => onEditingChange(false), [onEditingChange]);
  const term = useDebounced(search.trim(), 200);
  const query = { search: term, active: status === "all" ? undefined : status === "active", page };
  const list = useQuery({
    queryKey: ["inventory", "suppliers", query],
    queryFn: () => api().inventory.suppliers(query),
  });
  const revision = list.isError ? undefined : list.data?.generation;
  if (selected)
    return (
      <SupplierEditor
        key={selected.supplier.id}
        supplier={selected.supplier}
        generation={selected.generation}
        onClose={() => {
          setSelected(null);
          onEditingChange(false);
        }}
      />
    );
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("inventory.suppliers.title")}</h3>
        <Button
          disabled={!revision}
          onClick={() => {
            if (!revision) return;
            setSelected({
              generation: revision,
              supplier: {
                id: crypto.randomUUID(),
                name: "",
                email: null,
                phone: null,
                taxId: null,
                notes: null,
                active: true,
                version: 0,
              },
            });
            onEditingChange(true);
          }}
        >
          {t("inventory.suppliers.new")}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("inventory.suppliers.search")}
          maxLength={100}
          value={search}
          onChange={(event) => {
            onNavigation(
              { ...navigation, supplierSearch: event.target.value, inventoryPage: 1 },
              true,
            );
          }}
        />
        <SelectField
          label={t("inventory.suppliers.status")}
          value={status}
          onChange={(next) => {
            if (next === "all" || next === "active" || next === "inactive") {
              onNavigation({ ...navigation, supplierStatus: next, inventoryPage: 1 }, true);
            }
          }}
          options={[
            { value: "all", label: t("inventory.suppliers.all") },
            { value: "active", label: t("inventory.active") },
            { value: "inactive", label: t("inventory.inactive") },
          ]}
        />
      </div>
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {!list.isError && (
        <DataTable<Supplier>
          label={t("inventory.suppliers.title")}
          loading={list.isPending}
          columns={[
            {
              accessorKey: "name",
              header: t("inventory.suppliers.name"),
              meta: { cardTitle: true },
              enableSorting: false,
            },
            { accessorKey: "email", header: t("inventory.suppliers.email"), enableSorting: false },
            { accessorKey: "taxId", header: t("inventory.suppliers.taxId"), enableSorting: false },
            {
              accessorKey: "active",
              header: t("inventory.suppliers.status"),
              cell: ({ row }) => t(row.original.active ? "inventory.active" : "inventory.inactive"),
              enableSorting: false,
            },
          ]}
          data={list.data?.suppliers ?? []}
          getRowId={(row) => row.id}
          total={list.data?.pagination.total ?? 0}
          page={page}
          pageSize={list.data?.pagination.pageSize ?? 20}
          onPageChange={(inventoryPage) => onNavigation({ ...navigation, inventoryPage })}
          sorting={[]}
          onSortingChange={() => {}}
          onRowOpen={(supplier) => {
            if (!revision) return;
            setSelected({ generation: revision, supplier });
            onEditingChange(true);
          }}
          empty={<p className="text-muted">{t("inventory.suppliers.empty")}</p>}
        />
      )}
    </section>
  );
}

function SupplierEditor({
  supplier,
  generation,
  onClose,
}: {
  supplier: Supplier;
  generation: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const cache = useQueryClient();
  const toast = useToast();
  const heading = useId();
  const { id, version, ...initial } = supplier;
  const [fields, setFields] = useState(initial);
  const [confirm, setConfirm] = useState<"leave" | "archive" | null>(null);
  const dirty = Object.keys(initial).some(
    (key) => fields[key as keyof typeof fields] !== initial[key as keyof typeof fields],
  );
  const save = useMutation({
    mutationFn: (input: SupplierInput) => api().inventory.saveSupplier(id, input),
    onSuccess: async () => {
      toast.success(t("inventory.suppliers.saved"));
      await cache.invalidateQueries({ queryKey: ["inventory"] });
      onClose();
    },
  });
  const write = () =>
    save.mutate({
      name: fields.name.trim(),
      email: fields.email?.trim() || null,
      phone: fields.phone?.trim() || null,
      taxId: fields.taxId?.trim() || null,
      notes: fields.notes?.trim() || null,
      active: fields.active,
      version,
      generation,
    });
  return (
    <section className="space-y-4">
      <UnsavedGuard dirty={dirty} />
      <h3 id={heading} className="text-heading">
        {t(version ? "inventory.suppliers.edit" : "inventory.suppliers.new")}
      </h3>
      <form
        aria-labelledby={heading}
        method="post"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || save.isPending) return;
          if (supplier.active && !fields.active) setConfirm("archive");
          else write();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="name"
            label={t("inventory.suppliers.name")}
            required
            maxLength={160}
            value={fields.name}
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
            autoComplete="organization"
          />
          <TextField
            name="email"
            label={t("inventory.suppliers.email")}
            type="email"
            maxLength={254}
            value={fields.email ?? ""}
            onChange={(event) => setFields({ ...fields, email: event.target.value })}
            autoComplete="email"
          />
          <TextField
            name="phone"
            label={t("inventory.suppliers.phone")}
            type="tel"
            maxLength={50}
            value={fields.phone ?? ""}
            onChange={(event) => setFields({ ...fields, phone: event.target.value })}
            autoComplete="tel"
          />
          <TextField
            name="taxId"
            label={t("inventory.suppliers.taxId")}
            maxLength={50}
            value={fields.taxId ?? ""}
            onChange={(event) => setFields({ ...fields, taxId: event.target.value })}
          />
        </div>
        <TextAreaField
          name="notes"
          label={t("inventory.receipts.notes")}
          maxLength={1000}
          value={fields.notes ?? ""}
          onChange={(event) => setFields({ ...fields, notes: event.target.value })}
        />
        {version > 0 && (
          <label className="flex items-center gap-2">
            <input
              name="active"
              type="checkbox"
              checked={fields.active}
              onChange={(event) => setFields({ ...fields, active: event.target.checked })}
            />
            {t("inventory.suppliers.active")}
          </label>
        )}
        {save.isError && <ErrorState error={save.error} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!online || save.isPending}>
            {t("inventory.suppliers.save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => (dirty ? setConfirm("leave") : onClose())}
            disabled={save.isPending}
          >
            {t("inventory.suppliers.back")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        destructive
        title={t(confirm === "archive" ? "inventory.suppliers.archive" : "admin.unsaved.title")}
        description={t(
          confirm === "archive" ? "inventory.suppliers.archiveDescription" : "admin.unsaved.body",
        )}
        confirmLabel={t(
          confirm === "archive" ? "inventory.suppliers.archive" : "admin.unsaved.leave",
        )}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={() => {
          if (confirm === "archive" && online && !save.isPending) write();
          else if (confirm === "leave") onClose();
          setConfirm(null);
        }}
      />
    </section>
  );
}
