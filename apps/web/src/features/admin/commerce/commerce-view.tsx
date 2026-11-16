import { permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { useDebounced } from "../use-debounced";
import { AccountingView } from "./accounting-view";
import { CheckoutPanel } from "./checkout-panel";
import { invalidateCommerce } from "./invalidate";
import { InventoryView } from "./inventory-view";
import { inputCents } from "./money";
import { type CartProduct, ProductCart } from "./product-cart";
import { RewardsView } from "./rewards-view";

export function CommerceView({
  role,
  accessPreset,
}: {
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
}) {
  const permissions = permissionsFor(role, accessPreset);
  const { t, locale } = useI18n();
  const sales = useQuery({ queryKey: ["commerce", "sales"], queryFn: () => api().commerce.list() });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rewards, setRewards] = useState(false);
  const [accounting, setAccounting] = useState(false);
  const [inventory, setInventory] = useState(false);
  if (rewards)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setRewards(false)}>
          {t("commerce.back")}
        </Button>
        <RewardsView mode="admin" role={role} accessPreset={accessPreset} />
      </div>
    );
  if (accounting)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setAccounting(false)}>
          {t("commerce.back")}
        </Button>
        <AccountingView role={permissions.financialReports ? "owner" : role} />
      </div>
    );
  if (inventory)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setInventory(false)}>
          {t("commerce.back")}
        </Button>
        <InventoryView role={permissions.writeInventory ? "owner" : role} />
      </div>
    );
  return (
    <div className="space-y-6">
      <div className="commerce-destinations flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setInventory(true)}>
          {t("inventory.title")}
        </Button>
        <Button variant="secondary" onClick={() => setAccounting(true)}>
          {t(permissions.financialReports ? "accounting.title" : "accounting.own")}
        </Button>
        <Button variant="secondary" onClick={() => setRewards(true)}>
          {t("rewards.title")}
        </Button>
      </div>
      {permissions.manageCash && <CashRegister role="owner" />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading">{t("commerce.history")}</h2>
        <Button
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >
          {t("commerce.newSale")}
        </Button>
      </div>
      {creating && (
        <NewSale
          role={permissions.allSales ? "owner" : role}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
      {selected && (
        <div className="space-y-3">
          <Button variant="ghost" onClick={() => setSelected(null)}>
            {t("commerce.back")}
          </Button>
          <CheckoutPanel id={selected} mode="admin" role={role} />
        </div>
      )}
      {sales.isPending ? (
        <Skeleton className="h-48" />
      ) : sales.isError ? (
        <ErrorState error={sales.error} onRetry={() => void sales.refetch()} />
      ) : sales.data.checkouts.length === 0 ? (
        <EmptyState title={t("commerce.noSales")} description={t("commerce.noSalesHelp")} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sales.data.checkouts.map((sale) => (
            <li key={sale.id} className="min-w-0 rounded-xl border border-line bg-surface p-4">
              <p className="break-words font-semibold [overflow-wrap:anywhere]">
                {sale.lines.map((line) => line.description).join(", ")}
              </p>
              <p className="mt-1 text-sm text-muted">
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                  new Date(sale.createdAt),
                )}
              </p>
              <p className="my-3 flex justify-between gap-3">
                <span>{formatMoney(sale.totalCents, sale.currency, locale)}</span>
                <span className="text-sm">{t(`commerce.status.${sale.status}`)}</span>
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setSelected(sale.id);
                  setCreating(false);
                }}
              >
                {t("commerce.details")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function NewSale({ onCreated, role }: { onCreated: (id: string) => void; role: UserRole }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const staff = useQuery({ ...adminStaffQuery, enabled: role === "owner" });
  const [seller, setSeller] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customer, setCustomer] = useState("");
  const customerTerm = useDebounced(customerSearch.trim());
  const customers = useQuery({
    queryKey: ["rewards", "sale-customers", customerTerm],
    queryFn: () =>
      api().admin.clients.list({ search: customerTerm, pageSize: 8, sort: "name", order: "asc" }),
    enabled: customerTerm.length > 0,
  });
  const [items, setItems] = useState<CartProduct[]>([]);
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("0");
  const [tip, setTip] = useState("0");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: async () => {
      const unitAmountCents = description.trim() ? inputCents(price) : 0;
      const discountCents = inputCents(discount);
      const tipCents = inputCents(tip);
      if (
        (!description.trim() && !items.length) ||
        unitAmountCents === null ||
        discountCents === null ||
        tipCents === null ||
        items.some(
          (item) =>
            !item.quantity.trim() ||
            !Number.isInteger(Number(item.quantity)) ||
            Number(item.quantity) < 1 ||
            Number(item.quantity) > item.product.available ||
            Number(item.quantity) > 1000,
        )
      )
        throw new Error("Invalid sale");
      const subtotal =
        unitAmountCents +
        items.reduce((sum, item) => sum + item.product.priceCents * Number(item.quantity), 0);
      if (discountCents > subtotal) throw new Error("Invalid discount");
      return api().commerce.create({
        currency: "EUR",
        ...(seller ? { staffId: seller } : {}),
        ...(customer ? { clientId: customer } : {}),
        lines: [
          ...items.map((item) => ({
            kind: "product" as const,
            productId: item.product.id,
            quantity: Number(item.quantity),
            taxBasisPoints: 0,
          })),
          ...(description.trim()
            ? [
                {
                  kind: "custom" as const,
                  description: description.trim(),
                  quantity: 1,
                  unitAmountCents,
                  taxBasisPoints: 0,
                },
              ]
            : []),
        ],
        discountCents,
        tipCents,
        idempotencyKey: key,
      });
    },
    onSuccess: (sale) => {
      void invalidateCommerce(queries);
      onCreated(sale.id);
    },
  });
  const change = (set: (value: string) => void, value: string) => {
    set(value);
    create.reset();
    setKey(crypto.randomUUID());
  };
  return (
    <form
      className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("commerce.newSale")}</h3>
      <p className="text-sm text-muted sm:col-span-2">{t("commerce.customHelp")}</p>
      <div className="space-y-3 sm:col-span-2">
        <TextField
          label={t("loyalty.searchClient")}
          type="search"
          value={customerSearch}
          hint={t("loyalty.saleClientHelp")}
          onChange={(e) => {
            change(setCustomerSearch, e.target.value);
            setCustomer("");
          }}
        />
        {customers.isFetching && <Skeleton className="h-8" />}
        {customers.isError && (
          <ErrorState error={customers.error} onRetry={() => void customers.refetch()} />
        )}
        <SelectField
          label={t("loyalty.client")}
          value={customer}
          options={[
            { value: "", label: t("loyalty.chooseClient") },
            ...(customers.data?.clients ?? []).map((c) => ({
              value: c.id,
              label: `${c.name}${c.email ? ` · ${c.email}` : ""}`,
            })),
          ]}
          onChange={(value) => change(setCustomer, value)}
        />
      </div>
      {role === "owner" &&
        (staff.isPending ? (
          <Skeleton className="h-14" />
        ) : staff.isError ? (
          <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
        ) : (
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
              create.reset();
              setKey(crypto.randomUUID());
            }}
          />
        ))}
      <ProductCart
        items={items}
        onChange={(next) => {
          setItems(next);
          create.reset();
          setKey(crypto.randomUUID());
        }}
      />
      <TextField
        label={t("commerce.description")}
        value={description}
        onChange={(event) => change(setDescription, event.target.value)}
        maxLength={200}
      />
      <TextField
        label={`${t("commerce.price")} (EUR)`}
        value={price}
        inputMode="decimal"
        onChange={(event) => change(setPrice, event.target.value)}
      />
      <TextField
        label={t("commerce.discount")}
        value={discount}
        inputMode="decimal"
        onChange={(event) => change(setDiscount, event.target.value)}
      />
      <TextField
        label={t("commerce.tip")}
        value={tip}
        inputMode="decimal"
        onChange={(event) => change(setTip, event.target.value)}
      />
      {create.isError && (
        <p role="alert" className="text-danger-fg sm:col-span-2">
          {t("commerce.paymentError")}
        </p>
      )}
      <Button type="submit" disabled={create.isPending || !online}>
        {t("commerce.create")}
      </Button>
    </form>
  );
}
function CashRegister({ role }: { role: UserRole }) {
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const current = useQuery({
    queryKey: ["commerce", "cash"],
    queryFn: () => api().commerce.cash(),
  });
  const [opening, setOpening] = useState("0");
  const [counted, setCounted] = useState("");
  const changed = () => void invalidateCommerce(queries);
  const open = useMutation({
    mutationFn: () => {
      const value = inputCents(opening);
      if (value === null) throw new Error("Invalid count");
      return api().commerce.openCash(value);
    },
    onSuccess: changed,
  });
  const close = useMutation({
    mutationFn: () => {
      const value = inputCents(counted);
      if (value === null || !current.data?.session) throw new Error("Invalid count");
      return api().commerce.closeCash(current.data.session.id, value);
    },
    onSuccess: changed,
  });
  if (current.isPending) return <Skeleton className="h-40" />;
  if (current.isError)
    return <ErrorState error={current.error} onRetry={() => void current.refetch()} />;
  const session = current.data.session;
  const active = session && !session.closedAt;
  const money = (value: number) => formatMoney(value, "EUR", locale);
  return (
    <section
      aria-label={t("commerce.register")}
      className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading">{t("commerce.register")}</h2>
        <p className="text-sm font-medium">
          {t(active ? "commerce.registerOpen" : "commerce.registerClosed")}
        </p>
      </div>
      {session && (
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <dt className="text-sm text-muted">{t("commerce.expected")}</dt>
            <dd className="font-display text-xl">{money(session.expectedCents)}</dd>
          </div>
          {session.countedCents !== null && (
            <>
              <div>
                <dt className="text-sm text-muted">{t("commerce.counted")}</dt>
                <dd>{money(session.countedCents)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">{t("commerce.difference")}</dt>
                <dd
                  className={
                    session.differenceCents ? "font-semibold text-danger-fg" : "font-semibold"
                  }
                >
                  {money(session.differenceCents ?? 0)}
                </dd>
              </div>
            </>
          )}
        </dl>
      )}
      {role === "owner" &&
        (!active ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              open.mutate();
            }}
          >
            <TextField
              label={t("commerce.opening")}
              value={opening}
              inputMode="decimal"
              onChange={(event) => {
                setOpening(event.target.value);
                open.reset();
              }}
            />
            <Button type="submit" disabled={open.isPending || !online}>
              {t("commerce.openRegister")}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              close.mutate();
            }}
          >
            <TextField
              label={t("commerce.counted")}
              value={counted}
              inputMode="decimal"
              onChange={(event) => {
                setCounted(event.target.value);
                close.reset();
              }}
            />
            <Button type="submit" disabled={close.isPending || !online}>
              {t("commerce.closeRegister")}
            </Button>
          </form>
        ))}
      {(open.isError || close.isError) && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.registerError")}
        </p>
      )}
      {active && role === "owner" && <CashAdjustment />}
      {session && session.movements.length > 0 && (
        <details>
          <summary className="cursor-pointer py-2 font-medium">{t("commerce.movements")}</summary>
          <ul className="divide-y divide-line">
            {session.movements.map((movement) => (
              <li key={movement.id} className="flex justify-between gap-3 py-2">
                <span>{movement.reason}</span>
                <span className="tabular-nums">{money(movement.amountCents)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
function CashAdjustment() {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const changeKey = () => setKey(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () => {
      const value = inputCents(amount);
      if (value === null || value <= 0 || reason.trim().length < 3)
        throw new Error("Invalid adjustment");
      return api().commerce.adjustCash({
        kind,
        amountCents: value,
        reason: reason.trim(),
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      setAmount("");
      setReason("");
      changeKey();
      void invalidateCommerce(queries);
    },
  });
  return (
    <details>
      <summary className="cursor-pointer py-2 font-medium">{t("commerce.adjust")}</summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <SelectField
          label={t("commerce.movements")}
          value={kind}
          options={[
            { value: "deposit", label: t("commerce.deposit") },
            { value: "withdrawal", label: t("commerce.withdrawal") },
          ]}
          onChange={(value) => {
            setKind(value as "deposit" | "withdrawal");
            changeKey();
          }}
        />
        <TextField
          label={t("commerce.amount")}
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            save.reset();
            changeKey();
          }}
        />
        <TextField
          label={t("commerce.reason")}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            save.reset();
            changeKey();
          }}
        />
        {save.isError && <p role="alert">{t("commerce.registerError")}</p>}
        <Button type="submit" disabled={save.isPending}>
          {t("commerce.adjust")}
        </Button>
      </form>
    </details>
  );
}
