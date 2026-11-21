import {
  type AdminService,
  SERVICE_CATEGORY_MAX_LENGTH,
  type ServicePriceType,
  serviceCatalogCreateSchema,
  serviceCatalogUpdateSchema,
  servicePriceTypeSchema,
  serviceProcessingInputSchema,
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
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { catalogText } from "~/features/booking/catalog-browser";
import { priceLabel } from "~/features/booking/service-price";
import { PortfolioAdmin } from "~/features/reputation/portfolio";
import { useI18n } from "~/i18n/react";
import { adminServicesQuery, adminStaffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration } from "~/lib/format";
import { describeProblem } from "../problems";
import { ResourcesPanel } from "../resources/resources-panel";
import { UnsavedGuard } from "../unsaved-guard";
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

export function ServicesView({ initialServiceId }: { initialServiceId?: string } = {}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const services = useQuery(adminServicesQuery);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [draft, setDraft] = useState<{ parent: AdminService; kind: "variant" | "addon" }>();
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [editorRevision, setEditorRevision] = useState(0);
  const [editing, setEditing] = useState<AdminService | "new" | null>(null);
  const [deactivating, setDeactivating] = useState<AdminService | null>(null);
  const openedService = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialServiceId || openedService.current === initialServiceId) return;
    const row = services.data?.find((candidate) => candidate.id === initialServiceId);
    if (!row) return;
    openedService.current = initialServiceId;
    setEditing(row);
  }, [initialServiceId, services.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
    void queryClient.invalidateQueries({ queryKey: ["services"] });
    void queryClient.invalidateQueries({ queryKey: ["appointment-catalog"] });
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
        (!category || row.category === category) &&
        (!search.trim() ||
          catalogText(`${row.name} ${row.description ?? ""} ${row.category ?? ""}`).includes(
            catalogText(search),
          )),
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
  }, [services.data, sorting, search, category]);

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
          cell: (c) => priceLabel(t, locale, c.row.original, true),
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
      <ResourcesPanel services={services.data ?? []} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          type="search"
          label={t("services.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="block text-sm font-medium">
          {t("services.category")}
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1.5 min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-base"
          >
            <option value="">{t("services.allCategories")}</option>
            {[
              ...new Set(
                (services.data ?? []).map((s) => s.category).filter((s): s is string => Boolean(s)),
              ),
            ]
              .sort()
              .map((name) => (
                <option key={name}>{name}</option>
              ))}
          </select>
        </label>
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
        actions={
          <Button
            onClick={() => {
              setDraft(undefined);
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
                setDraft(undefined);
                setEditing("new");
              }}
            >
              {t("services.new")}
            </Button>
          </EmptyState>
        }
      />
      {rows.length === 0 && (search || category) && (
        <Button
          variant="secondary"
          onClick={() => {
            setSearch("");
            setCategory("");
          }}
        >
          {t("services.clearFilters")}
        </Button>
      )}
      {editing && (
        <ServiceSheet
          key={`${editing === "new" ? "new" : editing.id}:${editorRevision}`}
          service={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          catalog={services.data ?? []}
          draft={draft}
          onRelated={(parent, kind) => {
            setDraft({ parent, kind });
            setEditing("new");
            setEditorRevision((n) => n + 1);
          }}
          onOpenRelated={(row) => {
            setDraft(undefined);
            setEditing(row);
            setEditorRevision((n) => n + 1);
          }}
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

function serviceVersion(service: AdminService) {
  return service.version ?? service.catalog?.version ?? 1;
}

function withoutStaffRevision({
  staffIds: _staff,
  version: _version,
  catalog,
  ...fields
}: AdminService) {
  if (!catalog) return JSON.stringify(fields);
  const { version: _catalogRevision, ...terms } = catalog;
  return JSON.stringify({ ...fields, catalog: terms });
}

function ServiceSheet({
  service,
  onClose,
  onSaved,
  catalog,
  onReload,
  draft,
  onRelated,
  onOpenRelated,
}: {
  draft?: { parent: AdminService; kind: "variant" | "addon" };
  onRelated: (parent: AdminService, kind: "variant" | "addon") => void;
  onOpenRelated: (row: AdminService) => void;
  catalog: AdminService[];
  onReload: () => Promise<void>;
  service: AdminService | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const staff = useQuery(adminStaffQuery);
  const initial = useMemo(
    () =>
      service
        ? toForm(service)
        : draft
          ? {
              ...toForm(draft.parent),
              name: draft.kind === "variant" ? `${draft.parent.name} · ` : "",
              description: "",
              ...(draft.kind === "addon"
                ? { price: "0", durationMinutes: "0", bufferMinutes: "0" }
                : {}),
            }
          : emptyForm(catalog[0]?.currency ?? "EUR"),
    [service, draft, catalog],
  );
  const initialStaff = useMemo(
    () => [...(service?.staffIds ?? draft?.parent.staffIds ?? [])].sort(),
    [service, draft],
  );
  const [values, setValues] = useState<ServiceFormValues>(initial);
  const [staffIds, setStaffIds] = useState<string[]>(initialStaff);
  const [reviewedTeam, setReviewedTeam] = useState(() => ({
    version: service ? serviceVersion(service) : 1,
    ids: initialStaff,
  }));
  const [errors, setErrors] = useState<ServiceFormErrors>({});
  const [catalogKind, setCatalogKind] = useState<"service" | "variant" | "addon">(
    service?.catalog?.kind ?? draft?.kind ?? "service",
  );
  const [parentId, setParentId] = useState(
    service?.catalog?.kind === "variant"
      ? service.catalog.parentServiceId
      : draft?.kind === "variant"
        ? draft.parent.id
        : "",
  );
  const [optionLabel, setOptionLabel] = useState(
    service?.catalog?.kind === "variant" ? service.catalog.optionLabel : "",
  );
  const [allowedIds, setAllowedIds] = useState<string[]>(
    service?.catalog?.kind === "addon"
      ? service.catalog.allowedServiceIds
      : draft?.kind === "addon"
        ? [draft.parent.id]
        : [],
  );
  const defaults = {
    bookingIntervalMinutes: String(
      service?.bookingIntervalMinutes ?? draft?.parent.bookingIntervalMinutes ?? "",
    ),
    category: service?.category ?? draft?.parent.category ?? "",
    color: service?.color ?? draft?.parent.color ?? "",
    sortOrder: String(service?.sortOrder ?? 0),
    onlineBooking: service?.onlineBooking ?? draft?.parent.onlineBooking ?? true,
    clientInstructions:
      service?.clientInstructions ??
      (draft?.kind === "variant" ? (draft.parent.clientInstructions ?? "") : ""),
  };
  const [priceType, setPriceType] = useState<ServicePriceType>(
    service?.priceType ?? draft?.parent.priceType ?? "fixed",
  );
  const [presentation, setPresentation] = useState(defaults);
  const categoryListId = useId();
  const processingInitial = {
    enabled: Boolean(service?.processing),
    before: String(service?.processing?.startsAfterMinutes ?? ""),
    minutes: String(service?.processing?.minutes ?? ""),
  };
  const [processing, setProcessing] = useState(processingInitial);
  const processingDirty = JSON.stringify(processing) !== JSON.stringify(processingInitial);
  const [processingError, setProcessingError] = useState(false);
  const [presentationError, setPresentationError] = useState(false);
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
  const [showPhotos, setShowPhotos] = useState(false);
  const [photosVisited, setPhotosVisited] = useState(false);
  const [photosDirty, setPhotosDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [open, setOpen] = useState(true);
  const staffDirty = JSON.stringify([...staffIds].sort()) !== JSON.stringify(reviewedTeam.ids);
  const dirty =
    photosDirty ||
    metadataDirty ||
    priceType !== (service?.priceType ?? draft?.parent.priceType ?? "fixed") ||
    processingDirty ||
    JSON.stringify(presentation) !== JSON.stringify(defaults) ||
    JSON.stringify(values) !== JSON.stringify(initial) ||
    staffDirty;

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
        ...(presentation.color || service?.color ? { color: presentation.color || null } : {}),
        ...(priceType !== "fixed" || service?.priceType ? { priceType } : {}),
        ...(priceType === "variable" || priceType === "free" ? { priceCents: 0 } : {}),
        ...(processingDirty
          ? {
              processing: processing.enabled
                ? {
                    startsAfterMinutes: Number(processing.before),
                    minutes: Number(processing.minutes),
                  }
                : null,
            }
          : {}),
        ...(presentation.bookingIntervalMinutes || service?.bookingIntervalMinutes
          ? {
              bookingIntervalMinutes: presentation.bookingIntervalMinutes
                ? Number(presentation.bookingIntervalMinutes)
                : null,
            }
          : {}),
        ...(presentation.category || service?.category
          ? { category: presentation.category.trim() || null }
          : {}),
        ...(presentation.sortOrder !== "0" || service?.sortOrder
          ? { sortOrder: Number(presentation.sortOrder) }
          : {}),
        ...(!presentation.onlineBooking || service?.onlineBooking === false
          ? { onlineBooking: presentation.onlineBooking }
          : {}),
        ...(presentation.clientInstructions || service?.clientInstructions
          ? { clientInstructions: presentation.clientInstructions.trim() || null }
          : {}),
      };
      const draft = catalogDraft();
      if (!service)
        return api().admin.services.create({
          ...request,
          staffIds,
          ...(draft ? { catalog: serviceCatalogCreateSchema.parse(draft) } : {}),
        });
      const revision = reviewedTeam.version;
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

  const latest = service ? catalog.find((row) => row.id === service.id) : undefined;
  const liveTeam =
    latest && serviceVersion(latest) !== reviewedTeam.version
      ? { version: serviceVersion(latest), ids: [...latest.staffIds].sort() }
      : undefined;
  const updatedTeam =
    liveTeam && service && latest && withoutStaffRevision(latest) === withoutStaffRevision(service)
      ? liveTeam
      : undefined;
  const changedServiceAndTeam =
    liveTeam && !updatedTeam && JSON.stringify(liveTeam.ids) !== JSON.stringify(reviewedTeam.ids);

  if (updatedTeam && !staffDirty && open && !save.isPending && !reload.isPending) {
    setReviewedTeam(updatedTeam);
    setStaffIds(updatedTeam.ids);
  }

  function reviewUpdatedTeam() {
    if (!updatedTeam) return;
    const retained = updatedTeam.ids.filter(
      (id) => !reviewedTeam.ids.includes(id) || staffIds.includes(id),
    );
    const added = staffIds.filter((id) => !reviewedTeam.ids.includes(id));
    setStaffIds([...new Set([...retained, ...added])]);
    setReviewedTeam(updatedTeam);
  }

  function submit() {
    if (updatedTeam || changedServiceAndTeam) {
      staffSection.current?.focus();
      return;
    }
    const found = validateServiceForm(
      priceType === "variable" || priceType === "free" ? { ...values, price: "0" } : values,
      { allowZeroDuration: catalogKind === "addon" },
    );
    const draft = catalogDraft();
    const valid = !draft || serviceCatalogCreateSchema.safeParse(draft).success;
    const processingValid =
      !processing.enabled ||
      (serviceProcessingInputSchema.safeParse({
        version: 1,
        processing: {
          startsAfterMinutes: Number(processing.before),
          minutes: Number(processing.minutes),
        },
      }).success &&
        Number(processing.before) + Number(processing.minutes) < Number(values.durationMinutes));
    setProcessingError(!processingValid);
    const presentationValid =
      (!presentation.bookingIntervalMinutes ||
        (/^\d+$/.test(presentation.bookingIntervalMinutes) &&
          Number(presentation.bookingIntervalMinutes) >= 1 &&
          Number(presentation.bookingIntervalMinutes) <= 120)) &&
      presentation.category.trim().length <= SERVICE_CATEGORY_MAX_LENGTH &&
      presentation.clientInstructions.trim().length <= 2000 &&
      /^\d+$/.test(presentation.sortOrder) &&
      Number(presentation.sortOrder) <= 100000;
    setPresentationError(!presentationValid);
    setOptionsInvalid(!valid);
    setErrors(found);
    if (
      Object.keys(found).length === 0 &&
      valid &&
      presentationValid &&
      processingValid &&
      !save.isPending &&
      !reload.isPending
    )
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
  const staffSection = useRef<HTMLFieldSetElement>(null);
  const previewId = useId();
  const previewTitleId = useId();
  const [showPreview, setShowPreview] = useState(false);
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
            <Button
              loading={save.isPending}
              disabled={
                Boolean(updatedTeam || changedServiceAndTeam) || (service !== null && !dirty)
              }
              onClick={submit}
            >
              {t(service ? "admin.save" : "admin.create")}
            </Button>
          </div>
        }
      >
        {service && (
          <div className="mb-4 flex gap-2">
            <Button
              variant="secondary"
              aria-pressed={!showPhotos}
              onClick={() => setShowPhotos(false)}
            >
              {t("pos.general")}
            </Button>
            <Button
              variant="secondary"
              aria-pressed={showPhotos}
              onClick={() => {
                setPhotosVisited(true);
                setShowPhotos(true);
              }}
            >
              {t("pos.servicePhotos")}
            </Button>
          </div>
        )}
        <form
          hidden={showPhotos}
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={save.isPending || reload.isPending} className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => staffSection.current?.focus()}
              >
                {t("pos.employees")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                aria-expanded={showPreview}
                aria-controls={previewId}
                onClick={() => setShowPreview((visible) => !visible)}
              >
                {t("services.preview.title")}
              </Button>
            </div>
            <section
              id={previewId}
              hidden={!showPreview}
              aria-labelledby={previewTitleId}
              className="rounded-xl border border-dashed border-line-strong bg-sunken p-4"
            >
              <h3 id={previewTitleId} className="font-medium">
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
                  {previewCents === null && priceType !== "variable" && priceType !== "free"
                    ? "-"
                    : priceLabel(t, locale, {
                        priceType,
                        priceCents: previewCents ?? 0,
                        currency: /^[A-Za-z]{3}$/.test(values.currency)
                          ? values.currency.toUpperCase()
                          : "EUR",
                      })}
                </p>
              </div>
            </section>
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
                        setPriceType(parent.priceType ?? "fixed");
                        setPresentation((p) => ({
                          ...p,
                          category: parent.category ?? "",
                          onlineBooking: parent.onlineBooking ?? true,
                          bookingIntervalMinutes: String(parent.bookingIntervalMinutes ?? ""),
                          clientInstructions: parent.clientInstructions ?? "",
                        }));
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
            <TextAreaField
              label={t("services.field.description")}
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t("services.category")}
                list={categoryListId}
                maxLength={SERVICE_CATEGORY_MAX_LENGTH}
                value={presentation.category}
                onChange={(e) => setPresentation((p) => ({ ...p, category: e.target.value }))}
              />
              <datalist id={categoryListId}>
                {[...new Set(catalog.map((s) => s.category).filter(Boolean))].map((name) => (
                  <option key={name} value={name ?? ""} />
                ))}
              </datalist>
              <TextField
                label={t("services.sortOrder")}
                inputMode="numeric"
                value={presentation.sortOrder}
                onChange={(e) => setPresentation((p) => ({ ...p, sortOrder: e.target.value }))}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("pos.color")}</legend>
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
                ].map((color) => (
                  <button
                    type="button"
                    key={color}
                    aria-label={color || t("pos.noCategory")}
                    aria-pressed={presentation.color === color}
                    onClick={() => setPresentation((previous) => ({ ...previous, color }))}
                    className="flex size-11 items-center justify-center rounded-lg border border-line aria-pressed:border-accent aria-pressed:ring-2 aria-pressed:ring-accent"
                  >
                    <span
                      className="size-6 rounded-full border border-line"
                      style={{ backgroundColor: color || "var(--surface)" }}
                    />
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                checked={presentation.onlineBooking}
                onChange={(e) =>
                  setPresentation((p) => ({ ...p, onlineBooking: e.target.checked }))
                }
              />
              {t("services.onlineBooking")}
            </label>
            <TextAreaField
              label={t("services.instructions")}
              hint={t("services.instructionsHelp")}
              maxLength={2000}
              value={presentation.clientInstructions}
              onChange={(e) =>
                setPresentation((p) => ({ ...p, clientInstructions: e.target.value }))
              }
            />
            {presentationError && (
              <p role="alert" className="text-sm text-danger-fg">
                {t("services.error.invalid")}
              </p>
            )}
            <SelectField
              label={t("services.priceType")}
              value={priceType}
              onChange={(value) => setPriceType(servicePriceTypeSchema.parse(value))}
              options={servicePriceTypeSchema.options.map((value) => ({
                value,
                label: t(`services.price.${value}`),
              }))}
            />
            <p className="text-sm text-muted">{t("services.price.help")}</p>
            <TextField
              label={t("services.bookingInterval")}
              hint={t("services.bookingIntervalHelp")}
              inputMode="numeric"
              value={presentation.bookingIntervalMinutes}
              onChange={(e) =>
                setPresentation((p) => ({ ...p, bookingIntervalMinutes: e.target.value }))
              }
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
                disabled={priceType === "variable" || priceType === "free"}
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

            <fieldset className="space-y-3 rounded-lg border border-line p-4">
              <legend className="px-1 text-sm font-medium">{t("timing.processingTitle")}</legend>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={processing.enabled}
                  onChange={(e) => setProcessing((p) => ({ ...p, enabled: e.target.checked }))}
                />
                {t("timing.enableProcessing")}
              </label>
              {processing.enabled && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField
                    label={t("timing.before")}
                    type="number"
                    min={1}
                    value={processing.before}
                    onChange={(e) => setProcessing((p) => ({ ...p, before: e.target.value }))}
                  />
                  <TextField
                    label={t("timing.exposure")}
                    type="number"
                    min={1}
                    value={processing.minutes}
                    onChange={(e) => setProcessing((p) => ({ ...p, minutes: e.target.value }))}
                  />
                </div>
              )}
              {processingError && (
                <p role="alert" className="text-sm text-danger-fg">
                  {t("timing.processingInvalid")}
                </p>
              )}
            </fieldset>
            <fieldset ref={staffSection} tabIndex={-1} className="space-y-1">
              <legend className="mb-1 text-sm font-medium">{t("services.field.staff")}</legend>
              {updatedTeam && (
                <div className="space-y-2 rounded-md border border-line p-3">
                  <p role="status" className="text-sm">
                    {t("services.field.staff.changed")}
                  </p>
                  <Button type="button" variant="secondary" onClick={reviewUpdatedTeam}>
                    {t("services.field.staff.review")}
                  </Button>
                </div>
              )}
              {changedServiceAndTeam && (
                <div className="space-y-2 rounded-md border border-line p-3">
                  <p role="status" className="text-sm">
                    {t("services.field.staff.serviceChanged")}
                  </p>
                  <ul className="text-sm">
                    {(staff.data ?? [])
                      .filter((member) => liveTeam.ids.includes(member.id))
                      .map((member) => (
                        <li key={member.id}>{member.displayName}</li>
                      ))}
                  </ul>
                  <Button type="button" variant="secondary" onClick={() => reload.mutate()}>
                    {t(
                      dirty ? "services.field.staff.discardReload" : "services.field.staff.reload",
                    )}
                  </Button>
                </div>
              )}
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
          </fieldset>
        </form>
        {service && photosVisited && (
          <div hidden={!showPhotos}>
            <PortfolioAdmin
              associatedService={{ id: service.id, name: service.name }}
              onDirtyChange={setPhotosDirty}
              guardUnsaved={false}
            />
          </div>
        )}
        {service && !service.catalog && (
          <section
            hidden={showPhotos}
            aria-label={t("services.related")}
            className="mt-6 space-y-3 border-t border-line pt-5"
          >
            <h2 className="text-heading">{t("services.related")}</h2>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                disabled={dirty || save.isPending || reload.isPending}
                onClick={() => onRelated(service, "variant")}
              >
                {t("pos.addVariant")}
              </Button>
              <Button
                variant="secondary"
                disabled={dirty || save.isPending || reload.isPending}
                onClick={() => onRelated(service, "addon")}
              >
                {t("services.addExtra")}
              </Button>
            </div>
            <ul className="divide-y divide-line">
              {catalog
                .filter((row) =>
                  row.catalog?.kind === "variant"
                    ? row.catalog.parentServiceId === service.id
                    : row.catalog?.kind === "addon" &&
                      row.catalog.allowedServiceIds.includes(service.id),
                )
                .map((row) => (
                  <li key={row.id}>
                    <Button
                      variant="ghost"
                      disabled={dirty || save.isPending || reload.isPending}
                      onClick={() => onOpenRelated(row)}
                    >
                      {row.name}
                    </Button>
                  </li>
                ))}
            </ul>
          </section>
        )}
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
