import type { AdminService } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { PlusIcon, ScissorsIcon } from "~/components/ui/icons";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminServicesQuery, adminStaffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration, formatMoney } from "~/lib/format";
import { describeProblem } from "../problems";
import {
  centsToInput,
  parsePrice,
  type ServiceFormErrors,
  type ServiceFormValues,
  toServiceRequest,
  validateServiceForm,
} from "./form";

const helper = createColumnHelper<DataTableFeatures, AdminService>();

const emptyForm = (currency: string): ServiceFormValues => ({
  name: "",
  description: "",
  durationMinutes: "",
  bufferMinutes: "0",
  price: "",
  currency,
});

const toForm = (service: AdminService): ServiceFormValues => ({
  name: service.name,
  description: service.description ?? "",
  durationMinutes: String(service.durationMinutes),
  bufferMinutes: String(service.bufferMinutes),
  price: centsToInput(service.priceCents),
  currency: service.currency,
});

export function ServicesView() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const services = useQuery(adminServicesQuery);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [editing, setEditing] = useState<AdminService | "new" | null>(null);
  const [deactivating, setDeactivating] = useState<AdminService | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
    void queryClient.invalidateQueries({ queryKey: ["services"] });
    void queryClient.invalidateQueries({ queryKey: ["staff"] });
  };

  const deactivate = useMutation({
    mutationFn: (service: AdminService) => api().admin.services.deactivate(service.id),
    onSuccess: () => {
      toast.success(t("services.deactivated"));
      setDeactivating(null);
      refresh();
    },
    onError: (error) => {
      setDeactivating(null);
      toast.error(t(describeProblem(error).messageKey));
    },
  });
  const activate = useMutation({
    mutationFn: (service: AdminService) =>
      api().admin.services.update(service.id, { active: true }),
    onSuccess: () => {
      toast.success(t("services.activated"));
      refresh();
    },
    onError: (error) => toast.error(t(describeProblem(error).messageKey)),
  });

  const rows = useMemo(() => {
    const [sort] = sorting;
    const list = [...(services.data ?? [])];
    if (!sort) return list;
    const value = (s: AdminService): string | number =>
      sort.id === "duration"
        ? s.durationMinutes
        : sort.id === "price"
          ? s.priceCents
          : sort.id === "staff"
            ? s.staffIds.length
            : sort.id === "status"
              ? Number(s.active)
              : s.name.toLowerCase();
    list.sort(
      (a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (sort.desc ? -1 : 1),
    );
    return list;
  }, [services.data, sorting]);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          id: "name",
          header: t("services.col.name"),
          meta: { cardTitle: true },
        }),
        helper.accessor("durationMinutes", {
          id: "duration",
          header: t("services.col.duration"),
          cell: (c) => formatDuration(c.getValue(), locale),
        }),
        helper.accessor("bufferMinutes", {
          id: "buffer",
          header: t("services.col.buffer"),
          enableSorting: false,
          cell: (c) => formatDuration(c.getValue(), locale),
        }),
        helper.accessor("priceCents", {
          id: "price",
          header: t("services.col.price"),
          meta: { numeric: true },
          cell: (c) => formatMoney(c.getValue(), c.row.original.currency, locale),
        }),
        helper.accessor((row) => row.staffIds.length, {
          id: "staff",
          header: t("services.col.staff"),
          cell: (c) =>
            c.getValue() === 0 ? (
              <span className="text-muted">{t("services.noStaff")}</span>
            ) : (
              t("services.staffCount", { count: c.getValue() })
            ),
        }),
        helper.accessor("active", {
          id: "status",
          header: t("services.col.status"),
          cell: (c) => (
            <Badge tone={c.getValue() ? "success" : "neutral"}>
              {t(c.getValue() ? "services.status.active" : "services.status.inactive")}
            </Badge>
          ),
        }),
        helper.display({
          id: "actions",
          header: "",
          enableSorting: false,
          enableHiding: false,
          meta: { hideOnCard: false },
          cell: (c) => {
            const service = c.row.original;
            return service.active ? (
              <Button variant="ghost" onClick={() => setDeactivating(service)}>
                {t("services.deactivate")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                loading={activate.isPending && activate.variables?.id === service.id}
                onClick={() => activate.mutate(service)}
              >
                {t("services.activate")}
              </Button>
            );
          },
        }),
      ]),
    [t, locale, activate],
  );

  if (services.isError)
    return <ErrorState error={services.error} onRetry={() => void services.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          {t("services.new")}
        </Button>
      </div>
      <DataTable
        label={t("services.table")}
        columns={columns}
        data={rows}
        getRowId={(s) => s.id}
        total={rows.length}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        paginate={false}
        loading={services.isPending}
        sorting={sorting}
        onSortingChange={setSorting}
        onPageChange={() => {}}
        onRowOpen={setEditing}
        empty={
          <EmptyState
            title={t("services.empty.title")}
            description={t("services.empty.body")}
            icon={<ScissorsIcon width={24} height={24} />}
          >
            <Button onClick={() => setEditing("new")}>{t("services.new")}</Button>
          </EmptyState>
        }
      />
      {editing && (
        <ServiceSheet
          key={editing === "new" ? "new" : editing.id}
          service={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
        destructive
        pending={deactivate.isPending}
        title={t("services.deactivate.title", { name: deactivating?.name ?? "" })}
        description={t("services.deactivate.body")}
        confirmLabel={t("services.deactivate")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => deactivating && deactivate.mutate(deactivating)}
      />
    </div>
  );
}

function ServiceSheet({
  service,
  onClose,
  onSaved,
}: {
  service: AdminService | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const staff = useQuery(adminStaffQuery);
  const initial = useMemo(() => (service ? toForm(service) : emptyForm("ARS")), [service]);
  const initialStaff = useMemo(() => [...(service?.staffIds ?? [])].sort(), [service]);
  const [values, setValues] = useState<ServiceFormValues>(initial);
  const [staffIds, setStaffIds] = useState<string[]>(initialStaff);
  const [errors, setErrors] = useState<ServiceFormErrors>({});
  const [discarding, setDiscarding] = useState(false);
  const [open, setOpen] = useState(true);
  const dirty =
    JSON.stringify(values) !== JSON.stringify(initial) ||
    JSON.stringify([...staffIds].sort()) !== JSON.stringify(initialStaff);

  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);

  const save = useMutation({
    mutationFn: async () => {
      const request = toServiceRequest(values);
      let saved: AdminService;
      if (!service) {
        saved = await api().admin.services.create(request);
      } else {
        const changes = Object.fromEntries(
          Object.entries(request).filter(
            ([key, value]) => (toServiceRequest(initial) as Record<string, unknown>)[key] !== value,
          ),
        );
        saved =
          Object.keys(changes).length > 0
            ? await api().admin.services.update(service.id, changes)
            : service;
      }
      if (JSON.stringify([...staffIds].sort()) !== JSON.stringify(service ? initialStaff : [])) {
        saved = await api().admin.services.setStaff(saved.id, { staffIds });
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(t(service ? "services.saved" : "services.created"));
      onSaved();
      setOpen(false);
    },
    onError: (error) =>
      toast.error(`${t("services.saveFailed")}. ${t(describeProblem(error).messageKey)}`),
  });

  function submit() {
    const found = validateServiceForm(values);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  }

  const requestClose = (next: boolean) => {
    if (!next && dirty && !save.isPending) setDiscarding(true);
    else setOpen(next);
  };
  const set = (key: keyof ServiceFormValues, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const err = (key: keyof ServiceFormValues) =>
    errors[key] ? t(`services.error.${errors[key]}` as "services.error.required") : undefined;
  const activeStaff = (staff.data ?? []).filter((s) => s.active);

  const previewMinutes = Number(values.durationMinutes);
  const previewCents = parsePrice(values.price);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={requestClose}
        title={t(service ? "services.sheet.edit" : "services.sheet.create")}
        size="lg"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            {dirty && (
              <span className="text-sm text-warning-fg sm:mr-auto">{t("admin.unsaved.badge")}</span>
            )}
            <Button variant="secondary" onClick={() => requestClose(false)}>
              {t("admin.cancel")}
            </Button>
            <Button loading={save.isPending} disabled={service !== null && !dirty} onClick={submit}>
              {t(service ? "admin.save" : "admin.create")}
            </Button>
          </div>
        }
      >
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <TextField
            label={t("services.field.name")}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            error={err("name")}
            autoComplete="off"
          />
          <TextAreaField
            label={t("services.field.description")}
            value={values.description}
            onChange={(e) => set("description", e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("services.field.duration")}
              inputMode="numeric"
              value={values.durationMinutes}
              onChange={(e) => set("durationMinutes", e.target.value)}
              error={err("durationMinutes")}
            />
            <TextField
              label={t("services.field.buffer")}
              inputMode="numeric"
              value={values.bufferMinutes}
              onChange={(e) => set("bufferMinutes", e.target.value)}
              error={err("bufferMinutes")}
              hint={t("services.field.buffer.hint")}
            />
            <TextField
              label={t("services.field.price")}
              inputMode="decimal"
              value={values.price}
              onChange={(e) => set("price", e.target.value)}
              error={err("price")}
              hint={t("services.field.price.hint")}
            />
            <TextField
              label={t("services.field.currency")}
              value={values.currency}
              maxLength={3}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
              error={err("currency")}
            />
          </div>

          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">{t("services.field.staff")}</legend>
            {activeStaff.length === 0 && (
              <p className="text-sm text-muted">{t("services.field.staff.none")}</p>
            )}
            {activeStaff.map((member) => (
              <label
                key={member.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 hover:bg-sunken has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--accent)]"
                  checked={staffIds.includes(member.id)}
                  onChange={(e) =>
                    setStaffIds(
                      e.target.checked
                        ? [...staffIds, member.id]
                        : staffIds.filter((id) => id !== member.id),
                    )
                  }
                />
                {member.displayName}
              </label>
            ))}
          </fieldset>

          <section
            aria-labelledby="service-preview"
            className="rounded-xl border border-dashed border-line-strong bg-sunken p-4"
          >
            <h3 id="service-preview" className="font-medium">
              {t("services.preview.title")}
            </h3>
            <p className="mb-3 text-sm text-muted">{t("services.preview.lead")}</p>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="font-medium">{values.name.trim() || t("services.preview.untitled")}</p>
              {values.description.trim() && (
                <p className="mt-0.5 text-sm text-muted">{values.description.trim()}</p>
              )}
              <p className="mt-1 text-sm text-muted">
                {Number.isInteger(previewMinutes) && previewMinutes > 0
                  ? formatDuration(previewMinutes, locale)
                  : "-"}
                {" · "}
                {previewCents === null
                  ? "-"
                  : formatMoney(
                      previewCents,
                      /^[A-Za-z]{3}$/.test(values.currency) ? values.currency.toUpperCase() : "ARS",
                      locale,
                    )}
              </p>
            </div>
          </section>
        </form>
      </Sheet>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        destructive
        title={t("services.discard.title")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("admin.unsaved.leave")}
        cancelLabel={t("admin.unsaved.stay")}
        onConfirm={() => {
          setDiscarding(false);
          setOpen(false);
        }}
      />
    </>
  );
}
