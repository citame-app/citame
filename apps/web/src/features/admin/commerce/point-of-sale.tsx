import {
  type AdminClient,
  type CalendarAppointment,
  type Checkout,
  permissionsFor,
  type Service,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { CloseIcon, CreditCardIcon, PlusIcon, SearchIcon, UserIcon } from "~/components/ui/icons";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { servicesQuery } from "~/lib/queries";
import { localDayBounds } from "~/lib/zoned";
import { NewClient } from "../clients/new-client";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { BillingReviewReasons } from "./billing-review-reasons";
import { invalidateCommerce } from "./invalidate";
import { inputCents } from "./money";
import { extraIsEligible, type ReceiptItem, receiptInput } from "./pos-cart";

type CatalogTab = "quick" | "due" | "services" | "extras" | "products" | "custom";

export function PointOfSale({
  role,
  accessPreset,
  sales,
  onCreated,
  onBenefits,
}: {
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  sales: Checkout[];
  onCreated: (id: string) => void;
  onBenefits: (tab: "gift" | "packages" | "memberships") => void;
}) {
  const { t, locale } = useI18n();
  const permissions = permissionsFor(role, accessPreset);
  const online = useOnline();
  const queries = useQueryClient();
  const [tab, setTab] = useState<CatalogTab>("quick");
  const [search, setSearch] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [category, setCategory] = useState<string | null>(null);
  const receiptElement = useRef<HTMLElement | null>(null);
  const term = useDebounced(search.trim(), 200);
  const catalog = useQuery(servicesQuery);
  const products = useQuery({
    queryKey: ["inventory", "pos", term, productPage],
    queryFn: () =>
      api().inventory.list({
        search: term,
        active: "active",
        resellable: true,
        pageSize: 100,
        page: productPage,
      }),
    enabled: tab === "quick" || tab === "products",
  });
  const staff = useQuery({ ...adminStaffQuery, enabled: permissions.allSales });
  const [seller, setSeller] = useState("");
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [customer, setCustomer] = useState<AdminClient | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [discount, setDiscount] = useState("0");
  const [usingClientDiscount, setUsingClientDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<"fixed" | "percent">("fixed");
  const [tip, setTip] = useState("0");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const receipt = receiptInput(items, discount, discountType, tip);
  const create = useMutation({
    mutationFn: () => {
      if (!receipt.valid) throw new Error("Invalid receipt");
      return api().commerce.create({
        currency: "EUR",
        lines: receipt.lines,
        discountCents: receipt.discountCents,
        ...(usingClientDiscount ? { useClientDiscount: true } : {}),
        tipCents: receipt.tipCents,
        ...(seller ? { staffId: seller } : {}),
        ...(customer ? { clientId: customer.id } : {}),
        idempotencyKey: requestKey,
      });
    },
    onSuccess: (order) => {
      setItems([]);
      setCustomer(null);
      setDiscount("0");
      setUsingClientDiscount(false);
      setTip("0");
      setRequestKey(crypto.randomUUID());
      void invalidateCommerce(queries);
      onCreated(order.id);
    },
  });
  const changed = () => {
    setRequestKey(crypto.randomUUID());
    create.reset();
  };
  const add = (item: Omit<ReceiptItem, "quantity">) => {
    setItems((current) => {
      const previous = current.find((row) => row.key === item.key);
      return previous
        ? current.map((row) =>
            row.key === item.key
              ? {
                  ...row,
                  quantity: String(Math.min(Number(row.quantity) + 1, row.available ?? 1000, 1000)),
                }
              : row,
          )
        : [...current, { ...item, quantity: "1" }];
    });
    changed();
  };
  const services = (catalog.data ?? []).filter((item) => item.currency === "EUR");
  const frequencies = useMemo(() => {
    const result = new Map<string, number>();
    for (const sale of sales)
      for (const line of sale.lines) {
        const id = line.serviceId ?? line.productId;
        if (id && sale.fulfilledAt) result.set(id, (result.get(id) ?? 0) + line.quantity);
      }
    return result;
  }, [sales]);
  const visibleServices = services
    .filter(
      (item) =>
        (tab !== "extras" ? item.catalog?.kind !== "addon" : item.catalog?.kind === "addon") &&
        (category === null || (item.category ?? "") === category) &&
        (!term ||
          `${item.name} ${item.description ?? ""}`
            .toLocaleLowerCase(locale)
            .includes(term.toLocaleLowerCase(locale))),
    )
    .sort((a, b) =>
      tab === "quick" ? (frequencies.get(b.id) ?? 0) - (frequencies.get(a.id) ?? 0) : 0,
    );
  const serviceButton = (item: Service) => {
    const eligible = extraIsEligible(item, items);
    return (
      <button
        type="button"
        className="pos-catalog-item"
        key={item.id}
        disabled={!eligible || create.isPending}
        onClick={() =>
          add({
            key: `service:${item.id}`,
            kind: "service",
            id: item.id,
            service: item,
            name: item.name,
            priceCents: item.priceCents,
          })
        }
      >
        <span className="pos-item-name">
          {item.color && (
            <span
              className="mr-2 inline-block size-2.5 rounded-full"
              aria-hidden="true"
              style={{ backgroundColor: item.color }}
            />
          )}
          {item.name}
        </span>
        <span className="pos-item-detail">{formatDuration(item.durationMinutes, locale)}</span>
        <strong>{formatMoney(item.priceCents, item.currency, locale)}</strong>
        {!eligible && <span className="text-xs text-muted">{t("pos.extraNeedsService")}</span>}
      </button>
    );
  };
  return (
    <>
      <UnsavedGuard dirty={items.length > 0} preserveOnSearchChange />
      <div className="pos-workspace">
        <nav className="pos-categories" aria-label={t("pos.catalog")}>
          {(["quick", "due", "services", "extras", "products", "custom"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={value === tab}
              onClick={() => {
                setTab(value);
                setSearch("");
                setProductPage(1);
                setCategory(null);
              }}
            >
              {t(`pos.${value}`)}
            </button>
          ))}
          <div className="pos-category-divider" />
          {(["gift", "packages", "memberships"] as const).map((value) => (
            <button type="button" key={value} onClick={() => onBenefits(value)}>
              {t(value === "gift" ? "pos.gifts" : `pos.${value}`)}
            </button>
          ))}
        </nav>
        <section className="pos-catalog" aria-label={t(`pos.${tab}`)}>
          {tab === "custom" ? (
            <CustomAmount onAdd={add} disabled={create.isPending} />
          ) : tab === "due" ? (
            <DueAppointments onCreated={onCreated} />
          ) : (
            <>
              <TextField
                label={t("pos.search")}
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setProductPage(1);
                }}
                autoComplete="off"
                trailing={<SearchIcon className="mr-3 text-muted" />}
              />
              {(tab === "services" || tab === "extras") && (
                <fieldset className="pos-service-categories min-w-0 border-0 p-0">
                  <legend className="sr-only">{t("pos.category")}</legend>
                  {[
                    null,
                    ...new Set(
                      services
                        .filter((item) =>
                          tab === "extras"
                            ? item.catalog?.kind === "addon"
                            : item.catalog?.kind !== "addon",
                        )
                        .map((item) => item.category ?? ""),
                    ),
                  ].map((value) => (
                    <button
                      type="button"
                      key={value ?? "all"}
                      aria-pressed={category === value}
                      onClick={() => setCategory(value)}
                    >
                      {value === null ? t("pos.allServices") : value || t("pos.noCategory")}
                    </button>
                  ))}
                </fieldset>
              )}
              <h2 className="pos-catalog-heading">
                {t(
                  tab === "quick" && frequencies.size
                    ? "pos.popular"
                    : `pos.${tab === "quick" ? "services" : tab}`,
                )}
              </h2>
              {catalog.isPending && tab !== "products" ? (
                <Skeleton className="h-40" />
              ) : catalog.isError && tab !== "products" ? (
                <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
              ) : null}
              <div className="pos-catalog-list">
                {tab !== "products" && (
                  <div className="pos-item-grid">
                    {(tab === "quick" ? visibleServices.slice(0, 12) : visibleServices).map(
                      serviceButton,
                    )}
                  </div>
                )}
                {(tab === "products" || tab === "quick") && (
                  <>
                    {tab === "quick" && (
                      <h2 className="pos-catalog-heading">{t("pos.products")}</h2>
                    )}
                    {products.isPending ? (
                      <Skeleton className="h-24" />
                    ) : products.isError ? (
                      <ErrorState error={products.error} onRetry={() => void products.refetch()} />
                    ) : (
                      <div className="pos-item-grid">
                        {products.data.products.map((product) => (
                          <button
                            className="pos-catalog-item"
                            type="button"
                            key={product.id}
                            disabled={
                              (product.sellableAvailable ?? product.available) < 1 ||
                              create.isPending
                            }
                            onClick={() =>
                              add({
                                key: `product:${product.id}`,
                                kind: "product",
                                id: product.id,
                                name: product.name,
                                priceCents: product.priceCents,
                                available: product.sellableAvailable ?? product.available,
                              })
                            }
                          >
                            <span className="pos-item-name">{product.name}</span>
                            <span className="pos-item-detail">
                              {product.sku} ·{" "}
                              {t("pos.available", {
                                count: product.sellableAvailable ?? product.available,
                              })}
                            </span>
                            <strong>{formatMoney(product.priceCents, "EUR", locale)}</strong>
                          </button>
                        ))}
                      </div>
                    )}
                    {products.isSuccess && products.data.pagination.total > 100 && (
                      <div className="mt-3 flex justify-between gap-2">
                        <Button
                          variant="secondary"
                          disabled={productPage === 1}
                          onClick={() => setProductPage(productPage - 1)}
                        >
                          {t("table.previous")}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={productPage * 100 >= products.data.pagination.total}
                          onClick={() => setProductPage(productPage + 1)}
                        >
                          {t("table.next")}
                        </Button>
                      </div>
                    )}
                  </>
                )}
                {tab !== "quick" &&
                  (tab === "products"
                    ? products.isSuccess && products.data.products.length === 0
                    : catalog.isSuccess && visibleServices.length === 0) && (
                    <p className="pos-catalog-empty">{t("pos.noItems")}</p>
                  )}
              </div>
            </>
          )}
        </section>
        <button
          type="button"
          className="pos-mobile-basket"
          onClick={() => receiptElement.current?.scrollIntoView({ block: "start" })}
        >
          {t("pos.basket")} ({items.length}) ·{" "}
          {formatMoney(Number.isFinite(receipt.total) ? receipt.total : 0, "EUR", locale)}
        </button>
        <aside ref={receiptElement} className="pos-receipt" aria-label={t("pos.basket")}>
          <div className="pos-customer">
            <button
              type="button"
              className="pos-customer-button"
              disabled={!permissions.clients || create.isPending}
              onClick={() => setPickingCustomer(true)}
            >
              <UserIcon />
              <span>{customer?.name ?? t("pos.customer")}</span>
              <PlusIcon width={18} height={18} />
            </button>
            {customer && (
              <button
                type="button"
                className="calendar-icon-button"
                aria-label={t("pos.removeCustomer")}
                disabled={create.isPending}
                onClick={() => {
                  setCustomer(null);
                  if (usingClientDiscount) {
                    setDiscount("0");
                    setUsingClientDiscount(false);
                  }
                  changed();
                }}
              >
                <CloseIcon />
              </button>
            )}
          </div>
          {permissions.allSales &&
            (staff.isSuccess ? (
              <SelectField
                label={t("accounting.staff")}
                value={seller}
                options={[
                  { value: "", label: t("accounting.unassigned") },
                  ...staff.data
                    .filter((member) => member.active)
                    .map((member) => ({ value: member.id, label: member.displayName })),
                ]}
                onChange={(value) => {
                  setSeller(value);
                  changed();
                }}
                disabled={create.isPending}
              />
            ) : staff.isError ? (
              <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
            ) : (
              <Skeleton className="h-14" />
            ))}
          <div className="pos-receipt-lines">
            {!items.length ? (
              <div className="pos-empty-basket">
                <CreditCardIcon width={28} height={28} />
                <h2>{t("pos.empty")}</h2>
                <p>{t("pos.emptyHelp")}</p>
              </div>
            ) : (
              <ul>
                {items.map((item) => (
                  <li className="pos-receipt-line" key={item.key}>
                    <div className="flex items-start justify-between gap-2">
                      <strong>{item.name}</strong>
                      <button
                        type="button"
                        className="calendar-icon-button"
                        aria-label={t("pos.remove", { name: item.name })}
                        disabled={create.isPending}
                        onClick={() => {
                          setItems((current) => current.filter((row) => row.key !== item.key));
                          changed();
                        }}
                      >
                        <CloseIcon width={16} height={16} />
                      </button>
                    </div>
                    <div className="flex items-end justify-between gap-3">
                      <TextField
                        className="w-20"
                        label={t("inventory.quantity")}
                        type="number"
                        min={1}
                        max={Math.min(item.available ?? 1000, 1000)}
                        value={item.quantity}
                        disabled={create.isPending}
                        onChange={(e) => {
                          setItems((current) =>
                            current.map((row) =>
                              row.key === item.key ? { ...row, quantity: e.target.value } : row,
                            ),
                          );
                          changed();
                        }}
                      />
                      <span className="font-semibold tabular-nums">
                        {formatMoney(
                          Number.isInteger(Number(item.quantity))
                            ? item.priceCents * Number(item.quantity)
                            : item.priceCents,
                          "EUR",
                          locale,
                        )}
                      </span>
                    </div>
                    {item.service && !extraIsEligible(item.service, items) && (
                      <p role="alert" className="text-xs text-danger-fg">
                        {t("pos.extraNeedsService")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <form
            className="pos-receipt-total"
            onSubmit={(e) => {
              e.preventDefault();
              if (receipt.valid) create.mutate();
            }}
          >
            {items.length > 0 && (
              <details>
                <summary>
                  {t("commerce.discount")} · {t("commerce.tip")}
                </summary>
                <div className="grid grid-cols-2 gap-3 py-3">
                  <SelectField
                    label={t("pos.discountType")}
                    value={discountType}
                    options={[
                      { value: "fixed", label: t("pos.fixed") },
                      { value: "percent", label: t("pos.percent") },
                    ]}
                    onChange={(v) => {
                      setDiscountType(v as "fixed" | "percent");
                      setUsingClientDiscount(false);
                      changed();
                    }}
                    disabled={create.isPending}
                  />
                  <TextField
                    label={t("commerce.discount")}
                    value={discount}
                    inputMode="decimal"
                    disabled={create.isPending}
                    onChange={(e) => {
                      setDiscount(e.target.value);
                      setUsingClientDiscount(false);
                      changed();
                    }}
                  />
                  <TextField
                    label={`${t("commerce.tip")} (EUR)`}
                    value={tip}
                    inputMode="decimal"
                    disabled={create.isPending}
                    onChange={(e) => {
                      setTip(e.target.value);
                      changed();
                    }}
                  />
                </div>
              </details>
            )}
            <dl>
              <div>
                <dt>{t("pos.subtotal")}</dt>
                <dd>
                  {formatMoney(
                    Number.isFinite(receipt.subtotal) ? receipt.subtotal : 0,
                    "EUR",
                    locale,
                  )}
                </dd>
              </div>
              {receipt.discountCents > 0 && (
                <div>
                  <dt>{t("commerce.discount")}</dt>
                  <dd>−{formatMoney(receipt.discountCents, "EUR", locale)}</dd>
                </div>
              )}
              {receipt.tipCents > 0 && (
                <div>
                  <dt>{t("commerce.tip")}</dt>
                  <dd>{formatMoney(receipt.tipCents, "EUR", locale)}</dd>
                </div>
              )}
              <div className="pos-grand-total">
                <dt>{t("commerce.total")}</dt>
                <dd>
                  {formatMoney(Number.isFinite(receipt.total) ? receipt.total : 0, "EUR", locale)}
                </dd>
              </div>
            </dl>
            {items.length > 0 && !receipt.valid && (
              <p role="alert" className="text-sm text-danger-fg">
                {t("pos.validation")}
              </p>
            )}
            {create.isError && (
              <p role="alert" className="text-sm text-danger-fg">
                {t("commerce.paymentError")}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                aria-label={t("pos.clear")}
                disabled={!items.length || create.isPending}
                onClick={() => {
                  setItems([]);
                  setDiscount("0");
                  setTip("0");
                  changed();
                }}
              >
                <CloseIcon />
              </Button>
              <Button
                type="submit"
                className="min-w-0 flex-1 whitespace-normal"
                disabled={!receipt.valid || !online}
                loading={create.isPending}
              >
                {t("pos.pay")}
              </Button>
            </div>
          </form>
        </aside>
      </div>
      <Sheet
        open={pickingCustomer}
        onOpenChange={setPickingCustomer}
        title={t("pos.chooseCustomer")}
      >
        <CustomerPicker
          canCreate={permissions.editClients}
          onSelect={(client) => {
            setCustomer(client);
            const rate = client.contactDetails?.discountBasisPoints ?? 0;
            if (rate || usingClientDiscount) {
              setDiscountType("percent");
              setDiscount(String(rate / 100));
            }
            setUsingClientDiscount(rate > 0);
            setPickingCustomer(false);
            changed();
          }}
        />
      </Sheet>
    </>
  );
}

function CustomerPicker({
  onSelect,
  canCreate,
}: {
  onSelect: (customer: AdminClient) => void;
  canCreate: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 200);
  const customers = useQuery({
    queryKey: ["admin", "clients", "pos", term],
    queryFn: () =>
      api().admin.clients.list({ search: term, pageSize: 20, sort: "name", order: "asc" }),
    enabled: term.length > 0,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t("pos.customerHelp")}</p>
      {canCreate && <NewClient onCreated={onSelect} />}
      <TextField
        label={t("pos.searchCustomer")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />
      {customers.isFetching ? (
        <Skeleton className="h-20" />
      ) : customers.isError ? (
        <ErrorState error={customers.error} />
      ) : customers.data ? (
        <ul className="divide-y divide-line">
          {customers.data.clients.map((client) => (
            <li key={client.id}>
              <button type="button" className="pos-client-result" onClick={() => onSelect(client)}>
                <UserIcon />
                <span>
                  <strong>{client.name}</strong>
                  <span className="block text-sm text-muted">{client.phone ?? client.email}</span>
                </span>
              </button>
            </li>
          ))}
          {!customers.data.clients.length && (
            <li className="py-4 text-muted">{t("pos.noCustomers")}</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

function CustomAmount({
  onAdd,
  disabled,
}: {
  onAdd: (item: Omit<ReceiptItem, "quantity">) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const cents = inputCents(amount);
  const key = (value: string) =>
    setAmount((previous) =>
      value === "⌫"
        ? previous.slice(0, -1)
        : value === "." && (previous.includes(".") || previous.includes(","))
          ? previous
          : previous + value,
    );
  return (
    <form
      className="pos-custom"
      onSubmit={(e) => {
        e.preventDefault();
        if (cents !== null && cents > 0 && description.trim()) {
          onAdd({
            key: crypto.randomUUID(),
            kind: "custom",
            name: description.trim(),
            priceCents: cents,
          });
          setAmount("");
          setDescription("");
        }
      }}
    >
      <h2>{t("pos.custom")}</h2>
      <p className="text-sm text-muted">{t("pos.amountHelp")}</p>
      <TextField
        label={`${t("commerce.amount")} (EUR)`}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={disabled}
      />
      <TextField
        label={t("commerce.description")}
        value={description}
        maxLength={200}
        onChange={(e) => setDescription(e.target.value)}
        disabled={disabled}
      />
      <fieldset className="pos-keypad">
        <legend className="sr-only">{t("pos.keypad")}</legend>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((value) => (
          <button
            type="button"
            key={value}
            aria-label={value === "⌫" ? t("pos.backspace") : value}
            disabled={disabled}
            onClick={() => key(value)}
          >
            {value}
          </button>
        ))}
      </fieldset>
      <Button
        type="submit"
        disabled={disabled || cents === null || cents <= 0 || !description.trim()}
      >
        <PlusIcon />
        {t("pos.add")}
      </Button>
    </form>
  );
}

function DueAppointments({ onCreated }: { onCreated: (id: string) => void }) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [date, setDate] = useState(() => localDateOf(new Date().toISOString(), timeZone));
  const range = localDayBounds(date, timeZone);
  const appointments = useQuery({
    queryKey: ["commerce", "unpaid", range.from, range.to],
    queryFn: () => api().commerce.unpaid(range),
  });
  const requestKeys = useRef(new Map<string, string>());
  const create = useMutation({
    mutationFn: ({ id, externalBalance }: Pick<CalendarAppointment, "id" | "externalBalance">) => {
      const intent = externalBalance ? `${id}:verified-balance` : id;
      const key = requestKeys.current.get(intent) ?? crypto.randomUUID();
      requestKeys.current.set(intent, key);
      return api().commerce.create({
        appointmentId: id,
        currency: "EUR",
        lines: [],
        discountCents: 0,
        ...(externalBalance ? {} : { useClientDiscount: true }),
        tipCents: 0,
        idempotencyKey: key,
      });
    },
    onSuccess: (order) => {
      onCreated(order.id);
    },
    onError: () => {
      void queries.invalidateQueries({ queryKey: ["commerce", "unpaid"] });
    },
  });
  const due = appointments.data?.appointments ?? [];
  const review = appointments.data?.billingReview ?? [];
  return (
    <div className="space-y-4">
      <TextField
        label={t("pos.dueDate")}
        type="date"
        value={date}
        onChange={(e) => {
          if (e.target.value) setDate(e.target.value);
        }}
      />
      {appointments.isPending ? (
        <Skeleton className="h-40" />
      ) : appointments.isError ? (
        <ErrorState error={appointments.error} />
      ) : (
        <>
          {/* biome-ignore lint/a11y/noRedundantRoles: preserves list semantics in Safari when CSS hides markers. */}
          <ul className="pos-due-list" role="list">
            {due.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {formatTime(item.startsAt, timeZone, locale)} · {item.clientName}
                  </strong>
                  <p className="text-sm text-muted">{item.serviceNames.join(", ")}</p>
                </div>
                <Button
                  variant="secondary"
                  disabled={!online || create.isPending}
                  onClick={() => create.mutate(item)}
                >
                  {item.externalBalance
                    ? t("pos.collectBalance", {
                        amount: formatMoney(item.externalBalance.dueInCitameCents, "EUR", locale),
                      })
                    : t("pos.collect")}
                </Button>
              </li>
            ))}
            {!due.length && <li>{t("pos.noDue")}</li>}
          </ul>
          {review.length > 0 && (
            <section className="space-y-2" aria-labelledby="pos-billing-review">
              <h3 id="pos-billing-review" className="font-semibold">
                {t("pos.billingReview.title")}
              </h3>
              <p className="text-sm text-muted">{t("pos.billingReview.help")}</p>
              {/* biome-ignore lint/a11y/noRedundantRoles: preserves list semantics in Safari when CSS hides markers. */}
              <ul className="pos-due-list" role="list">
                {review.map((item) => {
                  const time = formatTime(item.startsAt, timeZone, locale);
                  return (
                    <li key={item.id}>
                      <div className="min-w-0 space-y-1">
                        <strong>
                          {time} · {item.clientName}
                        </strong>
                        <p className="text-sm text-muted">{item.serviceNames.join(", ")}</p>
                        <BillingReviewReasons reasons={item.reasons} />
                      </div>
                      <Link
                        to="/admin/calendar"
                        search={{
                          view: "day",
                          date: localDateOf(item.startsAt, timeZone),
                          appointment: item.id,
                          staff: item.staffId,
                        }}
                        className={buttonClasses({ variant: "secondary" })}
                      >
                        {t("pos.billingReview.open")}
                        <span className="sr-only">
                          {" "}
                          · {item.clientName} · {time}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
      {create.isError && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.paymentError")}
        </p>
      )}
    </div>
  );
}
