import {
  type BenefitPlan,
  createBenefitPlanSchema,
  type PassPeriod,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { CheckoutPanel } from "./checkout-panel";
import { invalidateCommerce } from "./invalidate";
import { centsInput, inputCents } from "./money";

type Props = { mode: CommerceMode; role: UserRole; accessPreset?: StaffAccessPreset | null };
export function PassesView({ mode, role, accessPreset }: Props) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const canManage = mode === "admin" && permissionsFor(role, accessPreset).editCatalog;
  const passes = useQuery({
    queryKey: ["passes", mode, "list", page, search],
    queryFn: () => api().passes.list(mode, page, search),
    refetchOnMount: "always",
    refetchInterval: 30000,
  });
  const plans = useQuery({
    queryKey: ["passes", "catalog", managing && canManage],
    queryFn: () => api().passes.plans(managing && canManage),
  });
  const capabilities = useQuery({
    queryKey: ["commerce", mode, "capabilities"],
    queryFn: () => api().commerce.capabilities(mode),
  });
  const unavailable = mode === "client" && !capabilities.data?.card && !capabilities.data?.bizum;
  if (selected)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelected(null)}>
          {t("passes.back")}
        </Button>
        <PassDetail id={selected} mode={mode} role={role} />
      </div>
    );
  return (
    <section aria-label={t("passes.title")} className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("passes.title")}</h2>
          <p className="text-muted">{t("passes.lead")}</p>
        </div>
        {canManage && (
          <Button variant="secondary" onClick={() => setManaging(!managing)}>
            {t("passes.manage")}
          </Button>
        )}
      </div>
      {managing && canManage && <PlanManager plans={plans.data?.plans ?? []} />}
      {unavailable && capabilities.isSuccess && (
        <p className="text-sm text-muted">{t("passes.unavailable")}</p>
      )}
      <h3 className="font-semibold">{t("passes.catalog")}</h3>
      {plans.isPending ? (
        <Skeleton className="h-24" />
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : plans.data.plans.filter((p) => p.active).length === 0 ? (
        <p className="text-sm text-muted">{t("passes.noPlans")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.data.plans
            .filter((p) => p.active)
            .map((plan) => (
              <PlanPurchase
                key={plan.id}
                plan={plan}
                mode={mode}
                disabled={unavailable || !capabilities.isSuccess}
                onCreated={setSelected}
              />
            ))}
        </div>
      )}
      <TextField
        label={t("passes.search")}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      {passes.isPending ? (
        <Skeleton className="h-40" />
      ) : passes.isError ? (
        <ErrorState error={passes.error} onRetry={() => void passes.refetch()} />
      ) : !passes.data.passes.length ? (
        <EmptyState title={t("passes.empty")} description={t("passes.emptyHelp")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {passes.data.passes.map((pass) => (
            <li key={pass.id} className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <h3 className="break-words font-semibold">{pass.name}</h3>
              <p className="text-sm text-muted">
                {t(`passes.status.${pass.status}`)} · {formatMoney(pass.priceCents, "EUR", locale)}
              </p>
              {pass.periods[0] && <VisitCounts period={pass.periods[0]} />}
              <Button variant="secondary" onClick={() => setSelected(pass.id)}>
                {t("passes.view")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {passes.data && <Pages page={page} total={passes.data.pagination.total} onChange={setPage} />}
    </section>
  );
}
function Pages({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (n: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex gap-3">
      <Button variant="secondary" disabled={page === 1} onClick={() => onChange(page - 1)}>
        {t("inventory.previous")}
      </Button>
      <span className="self-center">{page}</span>
      <Button variant="secondary" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>
        {t("inventory.next")}
      </Button>
    </div>
  );
}
function VisitCounts({ period }: { period: PassPeriod }) {
  const { t } = useI18n();
  return (
    <p className="text-sm">
      {t("passes.visits", {
        available: period.availableUses,
        used: period.usedUses,
        held: period.heldUses,
      })}
    </p>
  );
}
function PlanPurchase({
  plan,
  mode,
  disabled,
  onCreated,
}: {
  plan: BenefitPlan;
  mode: CommerceMode;
  disabled: boolean;
  onCreated: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [buyer, setBuyer] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const queries = useQueryClient();
  const online = useOnline();
  const clients = useQuery({
    ...clientsQuery({ search, pageSize: 20, sort: "name", order: "asc" }),
    enabled: mode === "admin" && open && search.trim().length > 0,
  });
  const buy = useMutation({
    mutationFn: () =>
      api().passes.purchase(
        {
          planId: plan.id,
          planVersion: plan.version,
          ...(mode === "admin" ? { clientId: buyer } : {}),
          renewalMode: "manual",
          acceptRecurring: false,
          idempotencyKey: key,
        },
        mode,
      ),
    onSuccess: (r) => {
      void invalidateCommerce(queries);
      onCreated(r.pass.id);
    },
  });
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h4 className="break-words font-semibold">{plan.name}</h4>
      <p>
        {formatMoney(plan.priceCents, "EUR", locale)} ·{" "}
        {t(plan.kind === "package" ? "passes.package" : "passes.membership")}
      </p>
      {plan.description && <p className="text-sm text-muted">{plan.description}</p>}
      <p className="text-sm">
        {t("passes.uses")}: {plan.includedUses}
      </p>
      {plan.discountBasisPoints > 0 && (
        <p>{t("passes.discounts", { discount: plan.discountBasisPoints / 100 })}</p>
      )}
      {plan.periodMonths && (
        <p className="text-sm">
          {t("passes.months")}: {plan.periodMonths}
        </p>
      )}
      {plan.validityDays && (
        <p className="text-sm">
          {t("passes.days")}: {plan.validityDays}
        </p>
      )}
      <Button variant="secondary" disabled={disabled || !online} onClick={() => setOpen(!open)}>
        {t("passes.buy")}
      </Button>
      {open && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            buy.mutate();
          }}
        >
          {mode === "admin" && (
            <>
              <TextField
                label={t("passes.searchBuyer")}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setBuyer("");
                  setKey(crypto.randomUUID());
                  buy.reset();
                }}
              />
              {clients.isError ? (
                <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
              ) : (
                <SelectField
                  label={t("passes.selectBuyer")}
                  value={buyer}
                  options={[
                    { value: "", label: t("passes.selectBuyer") },
                    ...(clients.data?.clients ?? []).map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  onChange={(v) => {
                    setBuyer(v);
                    setKey(crypto.randomUUID());
                    buy.reset();
                  }}
                />
              )}
            </>
          )}
          {plan.kind === "membership" && (
            <p className="text-sm text-muted">{t("passes.manualHelp")}</p>
          )}
          {buy.isError && <p role="alert">{t("passes.error")}</p>}
          <Button type="submit" disabled={!online || buy.isPending || (mode === "admin" && !buyer)}>
            {t("passes.create")}
          </Button>
        </form>
      )}
    </div>
  );
}
function PassDetail({ id, mode, role }: { id: string; mode: CommerceMode; role: UserRole }) {
  const { t, locale, timeZone } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [page, setPage] = useState(1);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const pass = useQuery({
    queryKey: ["passes", mode, id],
    queryFn: () => api().passes.get(id, mode),
    refetchInterval: 30000,
    refetchOnMount: "always",
  });
  const periods = useQuery({
    queryKey: ["passes", mode, id, "periods", page],
    queryFn: () => api().passes.periods(id, mode, page),
    refetchInterval: 30000,
  });
  const renew = useMutation({
    mutationFn: () => api().passes.renew(id, key, mode),
    onSuccess: (r) => {
      setReceipt(r.checkout.id);
      void invalidateCommerce(queries);
    },
  });
  const cancel = useMutation({
    mutationFn: () => {
      if (!pass.data) throw new Error("No pass");
      return api().passes.cancel(id, { version: pass.data.version, reason: reason.trim() }, mode);
    },
    onSuccess: () => {
      setReason("");
      void invalidateCommerce(queries);
    },
  });
  const capabilities = useQuery({
    queryKey: ["commerce", mode, "capabilities"],
    queryFn: () => api().commerce.capabilities(mode),
  });
  if (pass.isPending) return <Skeleton className="h-64" />;
  if (pass.isError) return <ErrorState error={pass.error} onRetry={() => void pass.refetch()} />;
  const row = pass.data;
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(new Date(value));
  return (
    <section aria-label={t("passes.view")} className="space-y-5">
      <h2 className="text-heading">{row.name}</h2>
      {row.discountBasisPoints > 0 && (
        <p>{t("passes.discounts", { discount: row.discountBasisPoints / 100 })}</p>
      )}
      {row.kind === "membership" && (
        <div className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-sm text-muted">
            {t(row.cancelAtPeriodEnd ? "passes.cancelledHelp" : "passes.manualHelp")}
          </p>
          {!row.cancelAtPeriodEnd && row.status === "active" && (
            <>
              <Button
                disabled={
                  !online ||
                  renew.isPending ||
                  (mode === "client" && !capabilities.data?.card && !capabilities.data?.bizum)
                }
                onClick={() => renew.mutate()}
              >
                {t("passes.renew")}
              </Button>
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  cancel.mutate();
                }}
              >
                <TextField
                  label={t("passes.reason")}
                  value={reason}
                  maxLength={300}
                  onChange={(e) => {
                    setReason(e.target.value);
                    cancel.reset();
                  }}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!online || cancel.isPending || reason.trim().length < 3}
                >
                  {t("passes.cancel")}
                </Button>
              </form>
            </>
          )}
          {(renew.isError || cancel.isError) && <p role="alert">{t("passes.error")}</p>}
        </div>
      )}
      <h3 className="font-semibold">{t("passes.periods")}</h3>
      {periods.isPending ? (
        <Skeleton className="h-32" />
      ) : periods.isError ? (
        <ErrorState error={periods.error} onRetry={() => void periods.refetch()} />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2">
            {periods.data.periods.map((period) => (
              <li
                key={period.id}
                className="space-y-2 rounded-xl border border-line bg-surface p-4"
              >
                <h4 className="font-semibold">{t("passes.period", { index: period.index + 1 })}</h4>
                <p>{t(`passes.status.${period.status}`)}</p>
                <VisitCounts period={period} />
                <p className="text-sm">{t("passes.returned", { count: period.returnedUses })}</p>
                <p>
                  {t("passes.remaining", {
                    amount: formatMoney(period.remainingAllocationCents, "EUR", locale),
                  })}
                </p>
                {period.startsAt && (
                  <p className="text-sm">{t("passes.from", { date: date(period.startsAt) })}</p>
                )}
                <p className="text-sm">
                  {period.endsAt
                    ? t("passes.until", { date: date(period.endsAt) })
                    : t("passes.noExpiry")}
                </p>
                <Button variant="secondary" onClick={() => setReceipt(period.checkoutId)}>
                  {t("passes.receipt")}
                </Button>
              </li>
            ))}
          </ul>
          <Pages page={page} total={periods.data.pagination.total} onChange={setPage} />
        </>
      )}
      {receipt && <CheckoutPanel id={receipt} mode={mode} role={role} />}
    </section>
  );
}
function PlanManager({ plans }: { plans: BenefitPlan[] }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<BenefitPlan | null | undefined>(undefined);
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-sm text-muted">{t("passes.planHelp")}</p>
      <Button onClick={() => setEditing(null)}>{t("passes.newPlan")}</Button>
      <ul className="space-y-2">
        {plans.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {p.name}
              {!p.active ? ` · ${t("inventory.inactive")}` : ""}
            </span>
            <Button
              variant="ghost"
              className="max-w-full whitespace-normal text-left"
              onClick={() => setEditing(p)}
            >
              {t("passes.editPlan")}: {p.name}
            </Button>
          </li>
        ))}
      </ul>
      {editing !== undefined && (
        <PlanEditor
          key={editing?.id ?? "new"}
          plan={editing}
          onSaved={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
function PlanEditor({ plan, onSaved }: { plan: BenefitPlan | null; onSaved: () => void }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [kind, setKind] = useState<"package" | "membership">(plan?.kind ?? "package");
  const [price, setPrice] = useState(plan ? centsInput(plan.priceCents) : "");
  const [uses, setUses] = useState(String(plan?.includedUses ?? 1));
  const [discount, setDiscount] = useState(String((plan?.discountBasisPoints ?? 0) / 100));
  const [tax, setTax] = useState(String((plan?.taxBasisPoints ?? 0) / 100));
  const [days, setDays] = useState(plan?.validityDays ? String(plan.validityDays) : "");
  const [months, setMonths] = useState(String(plan?.periodMonths ?? 1));
  const [services, setServices] = useState<string[]>(plan?.serviceIds ?? []);
  const [active, setActive] = useState(plan?.active ?? true);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const catalog = useQuery({
    queryKey: ["passes", "services"],
    queryFn: () => api().admin.services.list(),
  });
  const save = useMutation({
    mutationFn: () => {
      const data = createBenefitPlanSchema.parse({
        name,
        description: description.trim() || null,
        kind,
        priceCents: inputCents(price),
        includedUses: Number(uses),
        discountBasisPoints: kind === "package" ? 0 : inputCents(discount),
        taxBasisPoints: inputCents(tax),
        serviceIds: services,
        validityDays: kind === "package" && days ? Number(days) : null,
        periodMonths: kind === "membership" ? Number(months) : null,
        active,
        idempotencyKey: key,
      });
      if (!plan) return api().passes.createPlan(data);
      const { kind: _, idempotencyKey: __, ...change } = data;
      return api().passes.updatePlan(plan.id, { ...change, version: plan.version });
    },
    onSuccess: () => {
      void invalidateCommerce(queries);
      onSaved();
    },
  });
  const change = () => {
    setKey(crypto.randomUUID());
    save.reset();
  };
  return (
    <form
      className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">
        {t(plan ? "passes.editPlan" : "passes.newPlan")}
      </h3>
      <TextField
        label={t("passes.name")}
        value={name}
        maxLength={160}
        required
        onChange={(e) => {
          setName(e.target.value);
          change();
        }}
      />
      <SelectField
        label={t("passes.kind")}
        value={kind}
        disabled={!!plan}
        options={[
          { value: "package", label: t("passes.package") },
          { value: "membership", label: t("passes.membership") },
        ]}
        onChange={(v) => {
          setKind(v as typeof kind);
          change();
        }}
      />
      <TextField
        label={t("passes.description")}
        value={description}
        maxLength={1000}
        onChange={(e) => {
          setDescription(e.target.value);
          change();
        }}
      />
      <TextField
        label={t("passes.price")}
        inputMode="decimal"
        value={price}
        required
        onChange={(e) => {
          setPrice(e.target.value);
          change();
        }}
      />
      <TextField
        label={t("passes.uses")}
        type="number"
        min={kind === "package" ? 1 : 0}
        max={1000}
        value={uses}
        onChange={(e) => {
          setUses(e.target.value);
          change();
        }}
      />
      <TextField
        label={t("passes.tax")}
        inputMode="decimal"
        value={tax}
        onChange={(e) => {
          setTax(e.target.value);
          change();
        }}
      />
      {kind === "package" ? (
        <TextField
          label={t("passes.days")}
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            change();
          }}
        />
      ) : (
        <>
          <TextField
            label={t("passes.months")}
            type="number"
            min={1}
            max={12}
            value={months}
            onChange={(e) => {
              setMonths(e.target.value);
              change();
            }}
          />
          <TextField
            label={t("passes.discount")}
            inputMode="decimal"
            value={discount}
            onChange={(e) => {
              setDiscount(e.target.value);
              change();
            }}
          />
        </>
      )}
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="mb-2 font-medium">{t("passes.services")}</legend>
        {catalog.isPending ? (
          <Skeleton className="h-16" />
        ) : catalog.isError ? (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : (
          catalog.data.services
            .filter((s) => s.currency === "EUR" && s.active)
            .map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  checked={services.includes(s.id)}
                  onChange={(e) => {
                    setServices(
                      e.target.checked ? [...services, s.id] : services.filter((id) => id !== s.id),
                    );
                    change();
                  }}
                />
                {s.name}
              </label>
            ))
        )}
      </fieldset>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => {
            setActive(e.target.checked);
            change();
          }}
        />
        {t("passes.active")}
      </label>
      {save.isError && (
        <p role="alert" className="text-danger-fg sm:col-span-2">
          {t("passes.error")}
        </p>
      )}
      <Button type="submit" disabled={!online || save.isPending || !services.length}>
        {t("passes.save")}
      </Button>
    </form>
  );
}
