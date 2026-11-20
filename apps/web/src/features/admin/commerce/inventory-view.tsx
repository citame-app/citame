import {
  type PackageContent,
  packageContentSchema,
  permissionsFor,
  type Product,
  type ProductSort,
  productSortSchema,
  type StaffAccessPreset,
  type StockLedgerQuery,
  type UserRole,
} from "@sob/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { inventoryExportHref, stockLedgerExportHref } from "~/lib/api/inventory-endpoints";
import { formatMoney } from "~/lib/format";
import { useInventoryLiveRevision } from "../calendar/live-provider";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { centsInput, inputCents } from "./money";
import { ProductPhoto, ProductPhotoEditor } from "./product-photo";
import { StockAdjustment } from "./stock-adjustment";

type LedgerView = {
  search: string;
  kind: StockLedgerQuery["kind"];
  page: number;
  anchor: StockLedgerQuery["anchor"];
  revision: number;
};
type LedgerPageKey = Omit<LedgerView, "search"> & { term: string };
const ledgerPageKey = (position: LedgerPageKey, liveRevision: number) =>
  ["inventory", "ledger", position, liveRevision] as const;

export function InventoryView({
  role,
  accessPreset,
  userId,
}: {
  role: UserRole;
  userId?: string;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t, locale } = useI18n();
  const { readInventory, writeInventory, readCosts } = permissionsFor(role, accessPreset);
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 200);
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [resellable, setResellable] = useState("");
  const [active, setActive] = useState<"active" | "inactive" | "all">("active");
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<ProductSort>("name_asc");
  const facets = useQuery({
    queryKey: ["inventory", "facets"],
    queryFn: () => api().inventory.facets(),
    enabled: readInventory,
  });
  const [section, setSection] = useState<"products" | "movements" | "stock">("products");
  const [ledgerView, setLedgerView] = useState<LedgerView>({
    search: "",
    kind: undefined,
    page: 1,
    anchor: undefined,
    revision: 0,
  });
  const [selected, setSelected] = useState<Product | "new" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const viewedProduct = !writeInventory && selected !== "new" ? selected : null;
  const showDetail = Boolean(viewedProduct || (writeInventory && selected));
  const open = useMutation({
    mutationFn: (id: string) => api().inventory.get(id),
  });
  function openProduct(id: string, button: HTMLButtonElement) {
    open.mutate(id, {
      onSuccess: (product) => {
        if (!writeInventory) trigger.current = button;
        setSelected(product);
      },
    });
  }
  useEffect(() => {
    if (showDetail) return;
    trigger.current?.focus();
    trigger.current = null;
  }, [showDetail]);
  const filters = {
    search: term,
    active,
    lowStock,
    category: category || undefined,
    brand: brand || undefined,
    resellable: resellable ? resellable === "true" : undefined,
  };
  const catalog = { ...filters, sort, page, pageSize };
  const products = useQuery({
    queryKey: ["inventory", catalog, readCosts],
    queryFn: () => api().inventory.list(catalog),
    placeholderData: keepPreviousData,
    enabled: readInventory && !showDetail && section !== "movements",
  });
  const report = useQuery({
    queryKey: ["inventory", "report", filters, readCosts],
    queryFn: () => api().inventory.report(filters),
    enabled: readInventory && !showDetail && section !== "movements",
  });
  const pagination = products.data?.pagination;
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  if (!readInventory) return null;
  if (selected && writeInventory)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelected(null)}>
          {t("inventory.back")}
        </Button>
        <ProductEditor
          key={
            selected === "new"
              ? "new"
              : `${selected.id}-${selected.inventoryGeneration}-${selected.version}`
          }
          product={selected === "new" ? null : selected}
          userId={userId}
          onSaved={(product) =>
            setSelected((current) => (current === selected ? product : current))
          }
        />
      </div>
    );
  const catalogView = (
    <section
      hidden={Boolean(viewedProduct)}
      aria-label={t("inventory.title")}
      className="space-y-5"
    >
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("inventory.title")}</h2>
          <p className="text-muted">{t("inventory.lead")}</p>
        </div>
        {writeInventory && (
          <Button disabled={open.isPending} onClick={() => setSelected("new")}>
            {t("inventory.new")}
          </Button>
        )}
      </div>
      <nav className="commerce-section-nav" aria-label={t("inventory.title")}>
        {(["products", "movements", "stock"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={section === value}
            disabled={open.isPending}
            onClick={() => {
              setSection(value);
              open.reset();
              setPage(1);
              setLowStock(value === "stock");
            }}
          >
            {t(
              value === "products"
                ? "pos.inventoryOverview"
                : value === "movements"
                  ? "pos.stockLedger"
                  : "pos.stockCount",
            )}
          </button>
        ))}
      </nav>
      {open.isError && <ErrorState error={open.error} />}
      {section === "movements" ? (
        <StockLedger
          onOpen={openProduct}
          canManage={writeInventory}
          opening={open.isPending}
          view={ledgerView}
          setView={setLedgerView}
        />
      ) : (
        <>
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
              label={t("pos.category")}
              value={category}
              options={[
                { value: "", label: t("pos.allCategories") },
                ...(facets.data?.categories ?? []).map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => {
                setCategory(value);
                setPage(1);
              }}
            />
            <SelectField
              label={t("pos.brand")}
              value={brand}
              options={[
                { value: "", label: t("pos.allBrands") },
                ...(facets.data?.brands ?? []).map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => {
                setBrand(value);
                setPage(1);
              }}
            />
            <SelectField
              label={t("pos.salesFilter")}
              value={resellable}
              options={[
                { value: "", label: t("pos.allProducts") },
                { value: "true", label: t("pos.retail") },
                { value: "false", label: t("pos.internalUse") },
              ]}
              onChange={(value) => {
                setResellable(value);
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
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4">
            <div className="min-w-0">
              <h3 className="font-semibold">{t("inventory.report.title")}</h3>
              {report.isPending ? (
                <p role="status" className="mt-1 text-sm text-muted">
                  {t("admin.loading")}
                </p>
              ) : report.isError ? (
                <ErrorState error={report.error} onRetry={() => void report.refetch()} />
              ) : (
                <>
                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-3 text-sm">
                    {[
                      { label: t("inventory.report.products"), value: report.data.products },
                      { label: t("inventory.report.onHand"), value: report.data.onHand },
                      { label: t("inventory.report.reserved"), value: report.data.reserved },
                      {
                        label: t("inventory.report.available"),
                        value: report.data.onHand - report.data.reserved,
                      },
                      { label: t("inventory.report.low"), value: report.data.lowStockProducts },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <dt className="text-muted">{label}</dt>
                        <dd className="font-semibold tabular-nums">
                          {value.toLocaleString(locale)}
                        </dd>
                      </div>
                    ))}
                    {readCosts && report.data.valuation && (
                      <div>
                        <dt className="text-muted">{t("inventory.report.knownValue")}</dt>
                        <dd className="font-semibold tabular-nums">
                          {stockValue(report.data.valuation.knownCostCents, locale)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {readCosts && !!report.data.valuation?.productsMissingCost && (
                    <p className="mt-3 text-sm text-muted">
                      {t("inventory.report.missingCost", {
                        count: report.data.valuation.productsMissingCost,
                      })}
                    </p>
                  )}
                </>
              )}
            </div>
            <a
              className={buttonClasses({ variant: "secondary" })}
              href={inventoryExportHref({ ...filters, sort })}
              download
            >
              {t("inventory.report.export")}
            </a>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label={t("inventory.sort")}
              value={sort}
              options={productSortSchema.options.map((value) => ({
                value,
                label: t(`inventory.sort.${value}`),
              }))}
              onChange={(value) => {
                setSort(productSortSchema.parse(value));
                setPage(1);
              }}
            />
            <SelectField
              label={t("inventory.pageSize")}
              value={String(pageSize)}
              options={[20, 50, 100].map((value) => ({
                value: String(value),
                label: String(value),
              }))}
              onChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
            />
          </div>
          <p role="status" className="sr-only">
            {pagination &&
              !products.isPlaceholderData &&
              t("inventory.resultOrder", {
                order: t(`inventory.sort.${sort}`),
                count: pagination.total.toLocaleString(locale),
              })}
          </p>
          <div aria-busy={products.isFetching}>
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
                    <div className="flex items-center gap-3">
                      <ProductPhoto product={p} compact />
                      <h3 className="min-w-0 break-words font-semibold">{p.name}</h3>
                    </div>
                    <p className="text-sm text-muted">
                      {[p.brand, p.category].filter(Boolean).join(" · ")}
                    </p>
                    <p className="break-all text-sm text-muted">{p.sku}</p>
                    {p.resellable === false && (
                      <p className="text-sm text-muted">{t("pos.internalUse")}</p>
                    )}
                    <p>{formatMoney(p.priceCents, "EUR", locale)}</p>
                    <div className="text-sm">
                      <p>{t("inventory.onHand", { count: p.stockOnHand })}</p>
                      <p>{t("inventory.available", { count: p.available })}</p>
                      <p>{t("inventory.reserved", { count: p.stockReserved })}</p>
                    </div>
                    {p.lowStock && (
                      <p className="font-medium text-danger-fg">{t("inventory.low")}</p>
                    )}
                    <Button
                      variant="secondary"
                      disabled={open.isPending}
                      aria-label={
                        writeInventory ? undefined : t("inventory.viewNamed", { name: p.name })
                      }
                      onClick={(event) => openProduct(p.id, event.currentTarget)}
                    >
                      {t(writeInventory ? "inventory.manage" : "inventory.view")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {products.data && (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                disabled={page === 1 || products.isPlaceholderData}
                onClick={() => setPage(page - 1)}
              >
                {t("inventory.previous")}
              </Button>
              <span className="self-center text-sm text-muted tabular-nums">
                {t("inventory.page", { page, pages: totalPages })}
              </span>
              <Button
                variant="secondary"
                disabled={products.isPlaceholderData || page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                {t("inventory.next")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
  return (
    <>
      {viewedProduct && (
        <ProductOverview
          product={viewedProduct}
          readCosts={readCosts}
          onBack={() => setSelected(null)}
        />
      )}
      {catalogView}
    </>
  );
}

function ProductOverview({
  product,
  readCosts,
  onBack,
}: {
  product: Product;
  readCosts: boolean;
  onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const number = (value: number) => value.toLocaleString(locale);
  const details = [
    { label: t("inventory.sku"), value: product.sku },
    { label: t("inventory.barcode"), value: product.barcode },
    { label: t("pos.category"), value: product.category },
    { label: t("pos.brand"), value: product.brand },
    { label: t("inventory.location"), value: product.storageLocation },
    { label: t("inventory.unit"), value: product.unitLabel },
    {
      label: t("inventory.packageContent"),
      value: product.packageContent
        ? `${number(Number(product.packageContent.quantity))} ${product.packageContent.unit}`
        : null,
    },
    { label: t("inventory.report.onHand"), value: number(product.stockOnHand) },
    { label: t("inventory.report.reserved"), value: number(product.stockReserved) },
    { label: t("inventory.report.available"), value: number(product.available) },
    {
      label: t("inventory.price"),
      value:
        product.resellable === false
          ? null
          : formatMoney(product.priceCents, product.currency, locale),
    },
    {
      label: t("inventory.cost"),
      value:
        readCosts && product.costCents != null
          ? formatMoney(product.costCents, product.currency, locale)
          : null,
    },
    {
      label: t("inventory.filter"),
      value: t(product.active ? "inventory.active" : "inventory.inactive"),
    },
  ];
  return (
    <section className="space-y-5">
      <Button variant="ghost" onClick={onBack}>
        {t("inventory.back")}
      </Button>
      <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <h2 ref={heading} tabIndex={-1} className="text-heading break-words">
          {product.name}
        </h2>
        <ProductPhoto product={product} />
        {product.description && <p className="break-words text-muted">{product.description}</p>}
        {product.resellable === false && (
          <p className="text-sm text-muted">{t("pos.internalUse")}</p>
        )}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {details
            .filter(({ value }) => value != null && value !== "")
            .map(({ label, value }) => (
              <div key={label} className="min-w-0">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="break-words font-medium tabular-nums">{value}</dd>
              </div>
            ))}
        </dl>
      </div>
      <StockHistory key={product.id} product={product} />
    </section>
  );
}

function stockValue(cents: string, locale: string) {
  const value = BigInt(cents);
  const fraction = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
    useGrouping: false,
  }).format(Number(value % 100n));
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" })
    .formatToParts(value / 100n)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}

const packageFields = {
  packageQuantity: {
    inputMode: "decimal",
    hint: "inventory.packageQuantityHint",
    error: "inventory.packageQuantityError",
  },
  packageUnit: {
    inputMode: "text",
    hint: "inventory.packageUnitHint",
    error: "inventory.packageUnitError",
  },
} as const;

function ProductEditor({
  product,
  userId,
  onSaved,
}: {
  product: Product | null;
  userId?: string;
  onSaved: (product: Product) => void;
}) {
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [values, setValues] = useState({
    name: product?.name ?? "",
    sku: product?.sku ?? "",
    barcode: product?.barcode ?? "",
    category: product?.category ?? "",
    brand: product?.brand ?? "",
    description: product?.description ?? "",
    target: product?.targetStock == null ? "" : String(product.targetStock),
    price: product ? centsInput(product.priceCents) : "",
    cost: product?.costCents == null ? "" : centsInput(product.costCents),
    tax: String((product?.taxBasisPoints ?? 0) / 100),
    unit: product?.unitLabel ?? "unit",
    packageQuantity: product?.packageContent
      ? Number(product.packageContent.quantity).toLocaleString(locale, { useGrouping: false })
      : "",
    packageUnit: product?.packageContent?.unit ?? "",
    location: product?.storageLocation ?? "",
    threshold: String(product?.lowStockThreshold ?? 0),
    opening: "0",
  });
  const [netPrice, setNetPrice] = useState(
    product
      ? centsInput(Math.round((product.priceCents * 10000) / (10000 + product.taxBasisPoints)))
      : "",
  );
  const [resellable, setResellable] = useState(product?.resellable ?? true);
  const [dirty, setDirty] = useState(false);
  const catalogDirty = useRef(false);
  const markCatalogDirty = () => {
    catalogDirty.current = true;
    setDirty(true);
  };
  const [stockProduct, setStockProduct] = useState(product);
  const [packageError, setPackageError] = useState<"packageQuantity" | "packageUnit">();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const changed = async (p: Product) => {
    await queries.invalidateQueries({ queryKey: ["inventory"] });
    onSaved(p);
  };
  const stockChanged = async (p: Product) => {
    setStockProduct(p);
    await queries.invalidateQueries({ queryKey: ["inventory"] });
    if (!catalogDirty.current) onSaved(p);
  };
  const save = useMutation({
    mutationFn: (packageContent: PackageContent | null) => {
      const priceCents = inputCents(values.price);
      const costCents = values.cost.trim() ? inputCents(values.cost) : null;
      const taxBasisPoints = inputCents(values.tax);
      const lowStockThreshold = Number(values.threshold);
      const openingStock = Number(values.opening);
      const targetStock = values.target.trim() ? Number(values.target) : null;
      if (
        (targetStock !== null &&
          (!Number.isInteger(targetStock) || targetStock < 0 || targetStock > 999999999)) ||
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
        ...(values.sku.trim() ? { sku: values.sku.trim() } : {}),
        category: values.category.trim() || null,
        brand: values.brand.trim() || null,
        description: values.description.trim() || null,
        targetStock,
        resellable,
        barcode: values.barcode.trim() || null,
        priceCents,
        costCents,
        taxBasisPoints,
        unitLabel: values.unit.trim(),
        ...(packageContent || product?.packageContent ? { packageContent } : {}),
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
    ["sku", product ? "inventory.sku" : "pos.skuOptional"],
    ["barcode", "inventory.barcode"],
    ["category", "pos.category"],
    ["brand", "pos.brand"],
    ["target", "pos.targetStock"],
    ["price", "inventory.price"],
    ["cost", "inventory.cost"],
    ["tax", "inventory.tax"],
    ["unit", "inventory.unit"],
    ["packageQuantity", "inventory.packageQuantity"],
    ["packageUnit", "inventory.packageUnit"],
    ["location", "inventory.location"],
    ["threshold", "inventory.threshold"],
    ...(!product ? [["opening", "inventory.opening"]] : []),
  ] as [keyof typeof values, Parameters<typeof t>[0]][];
  return (
    <div className="space-y-6">
      <UnsavedGuard dirty={dirty} />
      <form
        className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (save.isPending || archive.isPending || !online) return;
          if (!values.packageQuantity.trim() && !values.packageUnit.trim()) {
            save.mutate(null);
            return;
          }
          const result = packageContentSchema.safeParse({
            quantity: values.packageQuantity,
            unit: values.packageUnit,
          });
          if (!result.success) {
            const field =
              result.error.issues[0]?.path[0] === "unit" ? "packageUnit" : "packageQuantity";
            setPackageError(field);
            const input = e.currentTarget.elements.namedItem(field);
            if (input instanceof HTMLInputElement) input.focus();
            return;
          }
          save.mutate(result.data);
        }}
      >
        <h3 className="font-semibold sm:col-span-2">
          {t(product ? "inventory.edit" : "inventory.new")}
        </h3>
        {fields.map(([field, label]) => {
          const packField =
            field === "packageQuantity" || field === "packageUnit"
              ? packageFields[field]
              : undefined;
          return (
            <TextField
              key={field}
              label={t(label)}
              name={field}
              value={values[field]}
              hint={packField && t(packField.hint)}
              error={packField && field === packageError ? t(packField.error) : undefined}
              inputMode={
                packField?.inputMode ??
                (["price", "cost", "tax"].includes(field)
                  ? "decimal"
                  : ["threshold", "opening", "target"].includes(field)
                    ? "numeric"
                    : "text")
              }
              onChange={(e) => {
                markCatalogDirty();
                if (packField) setPackageError(undefined);
                const next = { ...values, [field]: e.target.value };
                if (field === "price" || field === "tax") {
                  const gross = inputCents(next.price);
                  const tax = inputCents(next.tax);
                  setNetPrice(
                    gross === null || tax === null
                      ? ""
                      : centsInput(Math.round((gross * 10000) / (10000 + tax))),
                  );
                }
                setValues(next);
                setKey(crypto.randomUUID());
                save.reset();
              }}
            />
          );
        })}
        <TextField
          label={t("pos.netPrice")}
          inputMode="decimal"
          value={netPrice}
          onChange={(e) => {
            setNetPrice(e.target.value);
            const net = inputCents(e.target.value);
            const tax = inputCents(values.tax);
            if (net !== null && tax !== null) {
              setValues({
                ...values,
                price: centsInput(Math.round((net * (10000 + tax)) / 10000)),
              });
              markCatalogDirty();
              setKey(crypto.randomUUID());
              save.reset();
            }
          }}
        />
        <TextAreaField
          label={t("pos.description")}
          maxLength={1000}
          value={values.description}
          onChange={(e) => {
            setValues({ ...values, description: e.target.value });
            markCatalogDirty();
            setKey(crypto.randomUUID());
            save.reset();
          }}
        />
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={resellable}
            onChange={(e) => {
              setResellable(e.target.checked);
              markCatalogDirty();
              setKey(crypto.randomUUID());
              save.reset();
            }}
          />
          {t("pos.resellable")}
        </label>
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
      {product && stockProduct && (
        <>
          <ProductPhotoEditor product={product} />
          <StockAdjustment product={stockProduct} userId={userId} onSaved={stockChanged} />
          <StockHistory product={stockProduct} />
        </>
      )}
    </div>
  );
}
function StockHistory({ product }: { product: Product }) {
  const { t, locale, timeZone } = useI18n();
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: [
      "inventory",
      product.id,
      "movements",
      product.inventoryGeneration,
      product.version,
      page,
    ],
    queryFn: () => api().inventory.movements(product.id, page),
  });
  return (
    <section className="space-y-3">
      <h3 className="text-heading">{t("inventory.history")}</h3>
      {history.isPending ? (
        <Skeleton className="h-20" />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : product.inventoryGeneration !== history.data.inventoryGeneration ? (
        <p role="status" className="text-sm text-muted">
          {t("inventory.movementRefresh")}
        </p>
      ) : history.data.movements.length === 0 ? (
        <p className="text-sm text-muted">{t("pos.noMovements")}</p>
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
                      timeZone,
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

function StockLedger({
  onOpen,
  canManage,
  opening,
  view,
  setView,
}: {
  onOpen: (id: string, button: HTMLButtonElement) => void;
  canManage: boolean;
  opening: boolean;
  view: LedgerView;
  setView: Dispatch<SetStateAction<LedgerView>>;
}) {
  const { t, locale, timeZone } = useI18n();
  const cache = useQueryClient();
  const liveRevision = useInventoryLiveRevision();
  const { page, search, kind, anchor, revision } = view;
  const term = useDebounced(search.trim(), 200);
  const filters = { search: term, kind, anchor };
  const settled = term === search.trim();
  const ledger = useQuery({
    queryKey: ledgerPageKey({ page, term, kind, anchor, revision }, liveRevision),
    queryFn: ({ signal }) => api().inventory.ledger({ page, ...filters }, signal),
    enabled: settled,
    placeholderData: (previous, previousQuery) => {
      const from = previousQuery?.queryKey[2];
      return from?.page === page &&
        from.term === term &&
        from.kind === kind &&
        from.anchor === anchor &&
        from.revision === revision
        ? previous
        : undefined;
    },
  });
  const data = ledger.data;
  const restored =
    ledger.error instanceof ApiError && ledger.error.code === "sync_generation_changed";
  useEffect(() => {
    if (!settled || anchor || !data?.anchor || ledger.isPlaceholderData) return;
    cache.setQueryData(
      ledgerPageKey({ page, term, kind, anchor: data.anchor, revision }, liveRevision),
      data,
    );
    setView((current) => (current === view ? { ...current, anchor: data.anchor } : current));
  }, [
    anchor,
    cache,
    data,
    kind,
    ledger.isPlaceholderData,
    liveRevision,
    page,
    revision,
    setView,
    settled,
    term,
    view,
  ]);
  const showLatest = (updated: Partial<Pick<LedgerView, "search" | "kind">> = {}) =>
    setView((current) => ({
      ...current,
      ...updated,
      page: 1,
      anchor: undefined,
      revision: current.revision + 1,
    }));
  const goToPage = (number: number) =>
    setView((current) => ({ ...current, page: number, anchor: anchor ?? data?.anchor }));
  return (
    <section className="space-y-4" aria-label={t("pos.stockLedger")}>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("inventory.history.search")}
          value={search}
          maxLength={100}
          onChange={(e) => showLatest({ search: e.target.value })}
        />
        <SelectField
          label={t("inventory.movement")}
          value={kind ?? ""}
          onChange={(value) => showLatest({ kind: (value || undefined) as typeof kind })}
          options={[
            { value: "", label: t("pos.allMovements") },
            ...(["opening", "receive", "consume", "count", "sale", "return"] as const).map(
              (value) => ({
                value,
                label: t(value === "sale" ? "pos.movementSale" : `inventory.${value}`),
              }),
            ),
          ]}
        />
        <Button variant="secondary" onClick={() => showLatest()}>
          {t("inventory.history.latest")}
        </Button>
        {settled && data && !ledger.isError && (
          <a
            className={buttonClasses({ variant: "secondary" })}
            href={stockLedgerExportHref({ ...filters, anchor: anchor ?? data.anchor })}
            download
          >
            {t("inventory.history.export")}
          </a>
        )}
      </div>
      <p role="status" className="min-h-5 text-sm text-muted">
        {restored
          ? t("inventory.history.restored")
          : data?.hasNewer
            ? t("inventory.history.newer")
            : ""}
      </p>
      {ledger.isPending ? (
        <Skeleton className="h-40" />
      ) : restored ? null : ledger.isError ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {ledger.data.movements.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words font-semibold">{row.productName}</h3>
                  <p className="text-sm text-muted">
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone,
                    }).format(new Date(row.createdAt))}{" "}
                    · {t(row.kind === "sale" ? "pos.movementSale" : `inventory.${row.kind}`)}
                  </p>
                  <p className="break-words text-sm">{row.reason}</p>
                </div>
                <strong className="tabular-nums">
                  {row.quantityDelta > 0 ? "+" : ""}
                  {row.quantityDelta}
                </strong>
                <Button
                  variant="secondary"
                  disabled={opening}
                  aria-label={
                    canManage ? undefined : t("inventory.viewNamed", { name: row.productName })
                  }
                  onClick={(event) => onOpen(row.productId, event.currentTarget)}
                >
                  {t(canManage ? "inventory.manage" : "inventory.view")}
                </Button>
              </li>
            ))}
            {!ledger.data.movements.length && (
              <li className="p-5 text-muted">{t("pos.noMovements")}</li>
            )}
          </ul>
          <div className="flex items-center gap-3">
            <Button variant="secondary" disabled={page === 1} onClick={() => goToPage(page - 1)}>
              {t("inventory.previous")}
            </Button>
            <span>{page}</span>
            <Button
              variant="secondary"
              disabled={page * ledger.data.pagination.pageSize >= ledger.data.pagination.total}
              onClick={() => goToPage(page + 1)}
            >
              {t("inventory.next")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
