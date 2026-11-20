import {
  type AdminService,
  serviceCatalogCreateSchema,
  serviceCatalogUpdateSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { PortfolioAdmin } from "~/features/reputation/portfolio";
import { useI18n } from "~/i18n/react";
import { adminServicesQuery, adminStaffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration, formatMoney } from "~/lib/format";
import { describeProblem } from "../problems";
import { ResourcesPanel } from "../resources/resources-panel";
import { UnsavedGuard } from "../unsaved-guard";
import { CombinationsPanel } from "./combinations-panel";
import {
  centsToInput,
  parsePrice,
  type ServiceFormErrors,
  type ServiceFormValues,
  toServiceRequest,
  validateServiceForm,
} from "./form";
import { ProcessingPanel } from "./processing-panel";

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

export function ServicesView({ initialServiceId }: { initialServiceId?: string } = {}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const services = useQuery(adminServicesQuery);
  const [section, setSection] = useState<
    "services" | "extras" | "combos" | "resources" | "processing"
  >("services");
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [editorRevision, setEditorRevision] = useState(0);
  const [variantParent, setVariantParent] = useState<AdminService | null>(null);
  const [editing, setEditing] = useState<AdminService | "new" | null>(null);
  const openedService = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialServiceId || openedService.current === initialServiceId) return;
    const row = services.data?.find((service) => service.id === initialServiceId);
    if (row) {
      openedService.current = initialServiceId;
      setEditing(row);
      if (row.catalog?.kind === "addon") setSection("extras");
    }
  }, [initialServiceId, services.data]);
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
    const list = [...(services.data ?? [])].filter(
      (row) =>
        (section === "extras" ? row.catalog?.kind === "addon" : row.catalog?.kind !== "addon") &&
        (category === null || (row.category ?? "") === category) &&
        (!search.trim() ||
          `${row.name} ${row.description ?? ""}`
            .toLocaleLowerCase(locale)
            .includes(search.trim().toLocaleLowerCase(locale))),
    );
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
  }, [services.data, sorting, section, category, search, locale]);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          id: "name",
          header: t("services.col.name"),
          meta: { cardTitle: true },
          cell: (c) => (
            <span className="flex items-center gap-2">
              {c.row.original.color && (
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: c.row.original.color }}
                />
              )}
              {c.getValue()}
            </span>
          ),
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
      <nav className="commerce-section-nav" aria-label={t("services.title")}>
        {(["services", "extras", "combos", "resources", "processing"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={section === value}
            onClick={() => {
              setSection(value);
              setCategory(null);
            }}
          >
            {t(
              value === "services"
                ? "pos.services"
                : value === "extras"
                  ? "pos.extras"
                  : value === "combos"
                    ? "pos.combinations"
                    : value === "resources"
                      ? "pos.resources"
                      : "timing.processingTitle",
            )}
          </button>
        ))}
      </nav>
      {section === "combos" ? (
        <CombinationsPanel />
      ) : section === "resources" ? (
        <ResourcesPanel services={services.data ?? []} />
      ) : section === "processing" ? (
        <ProcessingPanel />
      ) : (
        <div className="catalog-directory">
          <nav className="catalog-directory-categories" aria-label={t("pos.category")}>
            <button
              type="button"
              aria-pressed={category === null}
              onClick={() => setCategory(null)}
            >
              {t("pos.allServices")}
              <span>
                {
                  (services.data ?? []).filter((row) =>
                    section === "extras"
                      ? row.catalog?.kind === "addon"
                      : row.catalog?.kind !== "addon",
                  ).length
                }
              </span>
            </button>
            {[
              ...new Set(
                (services.data ?? [])
                  .filter((row) =>
                    section === "extras"
                      ? row.catalog?.kind === "addon"
                      : row.catalog?.kind !== "addon",
                  )
                  .map((row) => row.category ?? ""),
              ),
            ]
              .sort()
              .map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  {value || t("pos.noCategory")}
                  <span>
                    {
                      (services.data ?? []).filter(
                        (row) =>
                          (row.category ?? "") === value &&
                          (section === "extras"
                            ? row.catalog?.kind === "addon"
                            : row.catalog?.kind !== "addon"),
                      ).length
                    }
                  </span>
                </button>
              ))}
          </nav>
          <div className="min-w-0 space-y-4">
            <TextField
              label={t("pos.search")}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
              actions={
                <Button
                  onClick={() => {
                    setVariantParent(null);
                    setEditing("new");
                  }}
                >
                  <PlusIcon />
                  {t("services.new")}
                </Button>
              }
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
                  <Button
                    onClick={() => {
                      setVariantParent(null);
                      setEditing("new");
                    }}
                  >
                    {t("services.new")}
                  </Button>
                </EmptyState>
              }
            />
          </div>
        </div>
      )}
      {editing && (
        <ServiceSheet
          key={`${editing === "new" ? "new" : editing.id}:${editorRevision}`}
          service={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          variantParent={editing === "new" ? variantParent : null}
          onAddVariant={(parent) => {
            setVariantParent(parent);
            setEditing("new");
          }}
          onEditVariant={(child) => {
            setVariantParent(null);
            setEditing(child);
          }}
          catalog={services.data ?? []}
          initialKind={section === "extras" ? "addon" : "service"}
          onReload={async () => {
            if (editing === "new") return;
            const result = await services.refetch();
            if (result.error) throw result.error;
            const current = result.data?.find((s) => s.id === editing.id);
            if (!current) throw new Error("Service no longer available");
            setEditing(current);
            setEditorRevision((n) => n + 1);
          }}
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
  catalog,
  onReload,
  initialKind,
  variantParent,
  onAddVariant,
  onEditVariant,
}: {
  variantParent: AdminService | null;
  onAddVariant: (parent: AdminService) => void;
  onEditVariant: (child: AdminService) => void;
  initialKind?: "service" | "addon";
  catalog: AdminService[];
  onReload: () => Promise<void>;
  service: AdminService | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const staff = useQuery(adminStaffQuery);
  const initial = useRef(
    service
      ? toForm(service)
      : variantParent
        ? { ...toForm(variantParent), name: "" }
        : emptyForm(catalog[0]?.currency ?? "EUR"),
  ).current;
  const initialStaff = useMemo(
    () => [...(service?.staffIds ?? variantParent?.staffIds ?? [])].sort(),
    [service, variantParent],
  );
  const [values, setValues] = useState<ServiceFormValues>(initial);
  const [staffIds, setStaffIds] = useState<string[]>(initialStaff);
  const [errors, setErrors] = useState<ServiceFormErrors>({});
  const [catalogKind, setCatalogKind] = useState<"service" | "variant" | "addon">(
    service?.catalog?.kind ?? (variantParent ? "variant" : initialKind) ?? "service",
  );
  const [editorSection, setEditorSection] = useState("general");
  const [photosVisited, setPhotosVisited] = useState(false);
  const [photosDirty, setPhotosDirty] = useState(false);
  const [category, setCategory] = useState(service?.category ?? variantParent?.category ?? "");
  const [color, setColor] = useState(service?.color ?? variantParent?.color ?? "");
  const [parentId, setParentId] = useState(
    service?.catalog?.kind === "variant"
      ? service.catalog.parentServiceId
      : (variantParent?.id ?? ""),
  );
  const [optionLabel, setOptionLabel] = useState(
    service?.catalog?.kind === "variant" ? service.catalog.optionLabel : "",
  );
  const [allowedIds, setAllowedIds] = useState<string[]>(
    service?.catalog?.kind === "addon" ? service.catalog.allowedServiceIds : [],
  );
  const [optionsInvalid, setOptionsInvalid] = useState(false);
  const kindId = useId();
  const parentSelectId = useId();
  const metadataDirty =
    catalogKind !== (service?.catalog?.kind ?? "service") ||
    optionLabel !== (service?.catalog?.kind === "variant" ? service.catalog.optionLabel : "") ||
    JSON.stringify([...allowedIds].sort()) !==
      JSON.stringify(
        service?.catalog?.kind === "addon" ? [...service.catalog.allowedServiceIds].sort() : [],
      ) ||
    parentId !== (service?.catalog?.kind === "variant" ? service.catalog.parentServiceId : "");
  const reload = useMutation({
    mutationFn: onReload,
    onError: (error) => toast.error(t(describeProblem(error).messageKey)),
  });
  const [discarding, setDiscarding] = useState(false);
  const [open, setOpen] = useState(true);
  const dirty =
    photosDirty ||
    category !== (service?.category ?? "") ||
    color !== (service?.color ?? "") ||
    metadataDirty ||
    JSON.stringify(values) !== JSON.stringify(initial) ||
    JSON.stringify([...staffIds].sort()) !== JSON.stringify(initialStaff);

  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);

  const catalogDraft = () =>
    catalogKind === "service"
      ? undefined
      : catalogKind === "variant"
        ? { kind: "variant" as const, parentServiceId: parentId, optionLabel }
        : { kind: "addon" as const, allowedServiceIds: allowedIds };
  const save = useMutation({
    mutationFn: async () => {
      const request = {
        ...toServiceRequest(values),
        ...(category.trim() || service?.category ? { category: category.trim() || null } : {}),
        ...(color || service?.color ? { color: color || null } : {}),
      };
      const draft = catalogDraft();
      if (!service)
        return api().admin.services.create({
          ...request,
          staffIds,
          ...(draft ? { catalog: serviceCatalogCreateSchema.parse(draft) } : {}),
        });
      const revision = service.version ?? service.catalog?.version ?? 1;
      const options =
        catalogKind === "service"
          ? undefined
          : serviceCatalogUpdateSchema.parse(
              catalogKind === "variant"
                ? { kind: "variant", version: revision, optionLabel }
                : { kind: "addon", version: revision, allowedServiceIds: allowedIds },
            );
      return api().admin.services.configure(service.id, {
        version: revision,
        service: request,
        staffIds,
        ...(options ? { catalog: options } : {}),
      });
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
    const found = validateServiceForm(values, { allowZeroDuration: catalogKind === "addon" });
    const draft = catalogDraft();
    const valid = !draft || serviceCatalogCreateSchema.safeParse(draft).success;
    setOptionsInvalid(!valid);
    setErrors(found);
    if (Object.keys(found).length || !valid) setEditorSection("general");
    if (Object.keys(found).length === 0 && valid && !save.isPending && !reload.isPending)
      save.mutate();
  }

  const requestClose = (next: boolean) => {
    if (save.isPending || reload.isPending) return;
    if (!next && dirty) setDiscarding(true);
    else setOpen(next);
  };
  const set = (key: keyof ServiceFormValues, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    // an edited field is no longer wrong until the next submit proves otherwise
    setErrors(({ [key]: _cleared, ...rest }) => rest);
  };
  const err = (key: keyof ServiceFormValues) =>
    errors[key] ? t(`services.error.${errors[key]}` as "services.error.required") : undefined;
  const activeStaff = (staff.data ?? []).filter((s) => s.active);

  const previewMinutes = Number(values.durationMinutes);
  const previewCents = parsePrice(values.price);

  return (
    <>
      <UnsavedGuard dirty={dirty} />
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
            <Button
              variant="secondary"
              disabled={save.isPending || reload.isPending}
              onClick={() => requestClose(false)}
            >
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
          <fieldset disabled={save.isPending || reload.isPending} className="space-y-5">
            <nav className="commerce-section-nav" aria-label={t("services.sheet.edit")}>
              {(["general", "staff", "photos", "preview"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={editorSection === value}
                  disabled={value === "photos" && !service}
                  onClick={() => {
                    setEditorSection(value);
                    if (value === "photos") setPhotosVisited(true);
                  }}
                >
                  {t(
                    value === "general"
                      ? "pos.general"
                      : value === "staff"
                        ? "pos.employees"
                        : value === "photos"
                          ? "pos.servicePhotos"
                          : "services.preview.title",
                  )}
                </button>
              ))}
            </nav>
            {save.isError && editorSection !== "general" && <ErrorState error={save.error} />}
            <div hidden={editorSection !== "general"} className="space-y-5">
              <p className="rounded-lg border border-line bg-sunken p-3 text-sm text-muted">
                {t("services.options.help")}
              </p>
              <div>
                <label htmlFor={kindId} className="mb-1.5 block text-sm font-medium">
                  {t("services.options.kind")}
                </label>
                <select
                  id={kindId}
                  disabled={Boolean(service)}
                  className="min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-base"
                  value={catalogKind}
                  onChange={(e) => {
                    const kind = e.target.value as typeof catalogKind;
                    setCatalogKind(kind);
                    setOptionsInvalid(false);
                    setParentId("");
                    setOptionLabel("");
                    setAllowedIds([]);
                    if (kind === "addon")
                      setValues((v) => ({ ...v, durationMinutes: "0", bufferMinutes: "0" }));
                  }}
                >
                  <option value="service">{t("services.options.service")}</option>
                  <option value="variant">{t("services.options.variant")}</option>
                  <option value="addon">{t("services.options.addon")}</option>
                </select>
              </div>
              {catalogKind === "variant" && (
                <>
                  <div>
                    <label htmlFor={parentSelectId} className="mb-1.5 block text-sm font-medium">
                      {t("services.options.parent")}
                    </label>
                    <select
                      id={parentSelectId}
                      disabled={Boolean(service)}
                      value={parentId}
                      className="min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-base"
                      onChange={(e) => {
                        setParentId(e.target.value);
                        const parent = catalog.find((s) => s.id === e.target.value);
                        if (parent) {
                          setValues({
                            ...toForm(parent),
                            name: optionLabel ? `${parent.name} · ${optionLabel}` : parent.name,
                          });
                          setStaffIds(parent.staffIds);
                        }
                      }}
                    >
                      <option value="">—</option>
                      {catalog
                        .filter((s) => !s.catalog && (s.active || s.id === parentId))
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <TextField
                    label={t("services.options.label")}
                    maxLength={80}
                    value={optionLabel}
                    onChange={(e) => {
                      const label = e.target.value;
                      setOptionLabel(label);
                      const parent = catalog.find((s) => s.id === parentId);
                      if (parent) setValues((v) => ({ ...v, name: `${parent.name} · ${label}` }));
                    }}
                  />
                </>
              )}
              {catalogKind === "addon" && (
                <>
                  <p className="text-sm text-muted">{t("services.options.zero")}</p>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">
                      {t("services.options.allowed")}
                    </legend>
                    {catalog
                      .filter(
                        (s) =>
                          s.id !== service?.id &&
                          s.catalog?.kind !== "addon" &&
                          (s.active || allowedIds.includes(s.id)),
                      )
                      .map((s) => (
                        <label
                          key={s.id}
                          className="flex min-h-11 items-center gap-3 rounded-md border border-line p-3"
                        >
                          <input
                            type="checkbox"
                            className="size-5 accent-accent"
                            checked={allowedIds.includes(s.id)}
                            onChange={(e) => {
                              setAllowedIds(
                                e.target.checked
                                  ? [...allowedIds, s.id]
                                  : allowedIds.filter((id) => id !== s.id),
                              );
                              if (e.target.checked && allowedIds.length === 0 && !service) {
                                setValues((v) => ({ ...v, currency: s.currency }));
                                setStaffIds(s.staffIds);
                              }
                            }}
                          />
                          {s.name}
                        </label>
                      ))}
                  </fieldset>
                </>
              )}
              {optionsInvalid && (
                <p role="alert" className="text-danger-fg">
                  {t("services.options.invalid")}
                </p>
              )}
              {save.isError && (
                <>
                  <ErrorState error={save.error} />
                  {service && (
                    <Button
                      variant="secondary"
                      loading={reload.isPending}
                      onClick={() => reload.mutate()}
                    >
                      {t("services.options.reload")}
                    </Button>
                  )}
                </>
              )}
              <TextField
                label={t("services.field.name")}
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                error={err("name")}
                autoComplete="off"
              />
              <TextField
                label={t("pos.category")}
                value={category}
                maxLength={100}
                list="service-category-options"
                hint={t("pos.categoryHelp")}
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id="service-category-options">
                {[...new Set(catalog.flatMap((row) => (row.category ? [row.category] : [])))]
                  .sort()
                  .map((value) => (
                    <option key={value} value={value} />
                  ))}
              </datalist>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("pos.color")}</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    "",
                    "#9F4661",
                    "#2C7B79",
                    "#3864A6",
                    "#B87927",
                    "#497548",
                    "#A94E43",
                    "#66717F",
                  ].map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-label={value || t("pos.noCategory")}
                      aria-pressed={color === value}
                      onClick={() => setColor(value)}
                      className="flex size-11 items-center justify-center rounded-lg border border-line aria-pressed:border-accent aria-pressed:ring-2 aria-pressed:ring-accent"
                    >
                      <span
                        className="size-6 rounded-full border border-line"
                        style={{ backgroundColor: value || "var(--surface)" }}
                      />
                    </button>
                  ))}
                </div>
              </div>
              <TextAreaField
                label={t("services.field.description")}
                value={values.description}
                onChange={(e) => set("description", e.target.value)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <fieldset className="sm:col-span-2">
                  <legend className="mb-2 text-sm font-medium">{t("services.col.duration")}</legend>
                  <div className="grid grid-cols-2 gap-3">
                    <TextField
                      label={t("pos.hours")}
                      type="number"
                      min={0}
                      max={24}
                      step={1}
                      value={Math.floor((Number(values.durationMinutes) || 0) / 60)}
                      onChange={(e) =>
                        set(
                          "durationMinutes",
                          String(
                            Number(e.target.value) * 60 +
                              ((Number(values.durationMinutes) || 0) % 60),
                          ),
                        )
                      }
                    />
                    <TextField
                      label={t("services.field.duration")}
                      type="number"
                      min={0}
                      max={59}
                      step={1}
                      value={
                        values.durationMinutes === "" ? "" : Number(values.durationMinutes) % 60
                      }
                      onChange={(e) =>
                        set(
                          "durationMinutes",
                          e.target.value === ""
                            ? ""
                            : String(
                                Math.floor((Number(values.durationMinutes) || 0) / 60) * 60 +
                                  Number(e.target.value),
                              ),
                        )
                      }
                      error={err("durationMinutes")}
                    />
                  </div>
                </fieldset>
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
              {service && !service.catalog && (
                <section className="space-y-3 rounded-xl border border-line p-4">
                  <h3 className="font-semibold">{t("pos.serviceVariants")}</h3>
                  <p className="text-sm text-muted">{t("pos.serviceVariantsHelp")}</p>
                  {catalog
                    .filter(
                      (row) =>
                        row.catalog?.kind === "variant" &&
                        row.catalog.parentServiceId === service.id,
                    )
                    .map((row) => (
                      <button
                        type="button"
                        key={row.id}
                        disabled={dirty}
                        className="flex min-h-11 w-full flex-wrap justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-sunken"
                        onClick={() => onEditVariant(row)}
                      >
                        <span>
                          {row.catalog?.kind === "variant" ? row.catalog.optionLabel : row.name}
                        </span>
                        <span>
                          {formatDuration(row.durationMinutes, locale)} ·{" "}
                          {formatMoney(row.priceCents, row.currency, locale)}
                        </span>
                      </button>
                    ))}
                  <Button
                    variant="secondary"
                    disabled={dirty}
                    onClick={() => onAddVariant(service)}
                  >
                    {t("pos.addVariant")}
                  </Button>
                  {dirty && <p className="text-xs text-muted">{t("pos.saveBeforeVariant")}</p>}
                </section>
              )}
            </div>
            <div hidden={editorSection !== "staff"}>
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
            </div>
            {service && photosVisited && (
              <div hidden={editorSection !== "photos"}>
                <PortfolioAdmin
                  associatedService={{ id: service.id, name: service.name }}
                  onDirtyChange={setPhotosDirty}
                  guardUnsaved={false}
                />
              </div>
            )}
            <div hidden={editorSection !== "preview"}>
              <section
                aria-labelledby="service-preview"
                className="rounded-xl border border-dashed border-line-strong bg-sunken p-4"
              >
                <h3 id="service-preview" className="font-medium">
                  {t("services.preview.title")}
                </h3>
                <p className="mb-3 text-sm text-muted">{t("services.preview.lead")}</p>
                <div className="rounded-lg border border-line bg-surface p-4">
                  <p className="font-medium">
                    {values.name.trim() || t("services.preview.untitled")}
                  </p>
                  {values.description.trim() && (
                    <p className="mt-0.5 text-sm text-muted">{values.description.trim()}</p>
                  )}
                  <p className="mt-1 text-sm text-muted">
                    {Number.isInteger(previewMinutes) && previewMinutes >= 0
                      ? previewMinutes === 0
                        ? t("booking.options.noTime")
                        : formatDuration(previewMinutes, locale)
                      : "-"}
                    {" · "}
                    {previewCents === null
                      ? "-"
                      : formatMoney(
                          previewCents,
                          /^[A-Za-z]{3}$/.test(values.currency)
                            ? values.currency.toUpperCase()
                            : "ARS",
                          locale,
                        )}
                  </p>
                </div>
              </section>
            </div>
          </fieldset>
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
