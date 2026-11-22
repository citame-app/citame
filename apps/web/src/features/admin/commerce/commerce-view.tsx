import { permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { AccountingView } from "./accounting-view";
import { CheckoutPanel } from "./checkout-panel";
import { invalidateCommerce } from "./invalidate";
import type { InventoryNavigation } from "./inventory-navigation";
import { InventoryView } from "./inventory-view";
import { inputCents } from "./money";
import { PointOfSale } from "./point-of-sale";
import { RewardsView } from "./rewards-view";
import { Transactions } from "./transactions";

export const COMMERCE_VIEWS = [
  "sale",
  "transactions",
  "cash",
  "inventory",
  "accounting",
  "rewards",
] as const;
export type CommerceViewName = (typeof COMMERCE_VIEWS)[number];

export function CommerceView({
  role,
  accessPreset,
  userId,
  view,
  onViewChange,
  checkoutId,
  bankPaymentId,
  rewardClientId,
  onCheckoutChange,
  inventoryNavigation,
  onInventoryNavigation,
}: {
  role: UserRole;
  userId?: string;
  accessPreset?: StaffAccessPreset | null;
  view?: CommerceViewName;
  onViewChange?: (view: CommerceViewName) => void;
  checkoutId?: string;
  bankPaymentId?: string;
  rewardClientId?: string;
  onCheckoutChange?: (id: string | null) => void;
  inventoryNavigation?: InventoryNavigation;
  onInventoryNavigation?: (navigation: InventoryNavigation, replace?: boolean) => void;
}) {
  const { t } = useI18n();
  const permissions = permissionsFor(role, accessPreset);
  const [localView, setLocalView] = useState<CommerceViewName>("sale");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [benefitsTab, setBenefitsTab] = useState<"gift" | "packages" | "memberships" | "loyalty">(
    "gift",
  );
  const active = view ?? localView;
  const selected = checkoutId ?? localSelected;
  const navigate = (next: CommerceViewName) => {
    if (onViewChange) onViewChange(next);
    else setLocalView(next);
  };
  const open = (id: string | null) => {
    if (onCheckoutChange) onCheckoutChange(id);
    else setLocalSelected(id);
  };
  const sales = useQuery({
    queryKey: ["commerce", "sales"],
    queryFn: () => api().commerce.list({ pageSize: 100 }),
  });
  const entries: { value: CommerceViewName; label: string }[] = [
    { value: "sale", label: t("pos.sale") },
    { value: "transactions", label: t("pos.transactions") },
    ...(permissions.manageCash ? [{ value: "cash" as const, label: t("pos.registers") }] : []),
    ...(permissions.readInventory
      ? [{ value: "inventory" as const, label: t("inventory.title") }]
      : []),
    {
      value: "accounting",
      label: t(permissions.financialReports ? "accounting.title" : "accounting.own"),
    },
    { value: "rewards", label: t("rewards.title") },
  ];
  return (
    <div className="commerce-workbench">
      <nav className="commerce-section-nav" aria-label={t("commerce.title")}>
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.value}
            aria-pressed={active === entry.value}
            onClick={() => navigate(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {active !== "sale" && (
        <Button variant="ghost" className="mb-4" onClick={() => navigate("sale")}>
          {t("commerce.back")}
        </Button>
      )}
      <div hidden={active !== "sale"}>
        <PointOfSale
          role={role}
          accessPreset={accessPreset}
          sales={sales.data?.checkouts ?? []}
          onCreated={(id) => open(id)}
          onBenefits={(tab) => {
            setBenefitsTab(tab);
            navigate("rewards");
          }}
        />
      </div>
      {active === "transactions" && <Transactions onOpen={(id) => open(id)} />}
      {active === "cash" && permissions.manageCash && <CashRegister role="owner" />}
      {active === "inventory" && permissions.readInventory && (
        <InventoryView
          role={role}
          accessPreset={accessPreset}
          userId={userId}
          navigation={inventoryNavigation}
          onNavigation={onInventoryNavigation}
        />
      )}
      {active === "accounting" && (
        <AccountingView role={permissions.financialReports ? "owner" : role} />
      )}
      {active === "rewards" && (
        <RewardsView
          key={rewardClientId ?? benefitsTab}
          initialTab={rewardClientId ? "stamps" : benefitsTab}
          stampClientId={rewardClientId}
          mode="admin"
          role={role}
          accessPreset={accessPreset}
        />
      )}
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(value) => {
          if (!value) open(null);
        }}
        title={t("commerce.receipt")}
        size="lg"
      >
        {selected && (
          <CheckoutPanel
            key={selected}
            id={selected}
            mode="admin"
            role={role}
            bankPaymentId={bankPaymentId}
          />
        )}
      </Sheet>
    </div>
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
  const [openingId, setOpeningId] = useState(() => crypto.randomUUID());
  const [counted, setCounted] = useState("");
  const [review, setReview] = useState<{ id: string; expectedCents: number } | null>(null);
  const [cashChanged, setCashChanged] = useState(false);
  const changed = () => void invalidateCommerce(queries);
  const open = useMutation({
    mutationFn: () => {
      const value = inputCents(opening);
      if (value === null) throw new Error("Invalid count");
      return api().commerce.openCash(value, openingId);
    },
    onSuccess: () => {
      setOpeningId(crypto.randomUUID());
      setOpening("0");
      setCashChanged(false);
      changed();
    },
  });
  const close = useMutation({
    mutationFn: () => {
      const value = inputCents(counted);
      if (value === null || !review) throw new Error("Invalid count");
      return api().commerce.closeCash(review.id, value, review.expectedCents);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "version_conflict") reviewAgain();
    },
    onSuccess: () => {
      setReview(null);
      setCounted("");
      setCashChanged(false);
      changed();
    },
  });
  function reviewAgain() {
    setReview(null);
    setCounted("");
    setCashChanged(true);
    void current.refetch();
  }
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
              disabled={open.isPending}
              onChange={(event) => {
                setOpening(event.target.value);
                setOpeningId(crypto.randomUUID());
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
              if (
                review &&
                (review.id !== session.id || review.expectedCents !== session.expectedCents)
              ) {
                reviewAgain();
                return;
              }
              close.mutate();
            }}
          >
            <TextField
              label={t("commerce.counted")}
              value={counted}
              inputMode="decimal"
              disabled={close.isPending || (cashChanged && current.isFetching)}
              onChange={(event) => {
                setCounted(event.target.value);
                setReview(
                  (prior) => prior ?? { id: session.id, expectedCents: session.expectedCents },
                );
                setCashChanged(false);
                close.reset();
              }}
            />
            <Button type="submit" disabled={close.isPending || !online}>
              {t("commerce.closeRegister")}
            </Button>
          </form>
        ))}
      {(cashChanged || open.isError || close.isError) && (
        <p role="alert" className="text-danger-fg">
          {t(cashChanged ? "commerce.cashChanged" : "commerce.registerError")}
        </p>
      )}
      {active && role === "owner" && <CashAdjustment key={session.id} sessionId={session.id} />}
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
function CashAdjustment({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
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
        sessionId,
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
        <Button type="submit" disabled={save.isPending || !online}>
          {t("commerce.adjust")}
        </Button>
      </form>
    </details>
  );
}
