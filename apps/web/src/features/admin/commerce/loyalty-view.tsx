import { permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { useDebounced } from "../use-debounced";
import { CheckoutPanel } from "./checkout-panel";
import { LoyaltyPolicyForm } from "./loyalty-policy-form";
import { PromotionsView } from "./promotions-view";

export function LoyaltyView({
  mode,
  role,
  accessPreset,
  clientId,
}: {
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  clientId?: string | null;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(clientId ?? "");
  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    queryKey: ["rewards", "customers", debounced],
    queryFn: () =>
      api().admin.clients.list({ search: debounced, pageSize: 8, sort: "name", order: "asc" }),
    enabled: mode === "admin" && !clientId && debounced.length > 0,
  });
  const permissions = permissionsFor(role, accessPreset);
  return (
    <section aria-label={t("loyalty.title")} className="space-y-6">
      <h2 className="text-heading">{t("loyalty.title")}</h2>
      {mode === "admin" && !clientId && role === "owner" && <LoyaltyPolicyForm />}
      {mode === "admin" && !clientId && (
        <div className="space-y-3 rounded-xl border border-line p-4">
          <TextField
            label={t("loyalty.searchClient")}
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected("");
            }}
          />
          {clients.isFetching && <Skeleton className="h-8" />}
          {clients.isError && (
            <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
          )}
          <SelectField
            label={t("loyalty.client")}
            value={selected}
            options={[
              { value: "", label: t("loyalty.chooseClient") },
              ...(clients.data?.clients ?? []).map((c) => ({
                value: c.id,
                label: `${c.name}${c.email ? ` · ${c.email}` : ""}`,
              })),
            ]}
            onChange={setSelected}
          />
        </div>
      )}
      {mode === "client" || selected ? (
        <ClientStatement
          key={mode === "client" ? (clientId ?? "me") : selected}
          clientId={mode === "client" ? (clientId ?? undefined) : selected}
          mode={mode}
          role={role}
          canAdjust={mode === "admin" && permissions.refunds}
        />
      ) : (
        <p className="text-sm text-muted">{t("loyalty.emptyClient")}</p>
      )}
      {mode === "admin" && !clientId && permissions.editCatalog && <PromotionsView />}
    </section>
  );
}
const movementKeys = {
  earn: "loyalty.movement.earn",
  adjustment: "loyalty.movement.adjustment",
  redemption: "loyalty.movement.redemption",
  redemption_return: "loyalty.movement.redemption_return",
  refund_adjustment: "loyalty.movement.refund_adjustment",
  expiry: "loyalty.movement.expiry",
} as const;
function ClientStatement({
  clientId,
  mode,
  role,
  canAdjust,
}: {
  clientId?: string;
  mode: CommerceMode;
  role: UserRole;
  canAdjust: boolean;
}) {
  const { t, locale, timeZone } = useI18n();
  const [page, setPage] = useState(1);
  const [receipt, setReceipt] = useState<string | null>(null);
  const statement = useQuery({
    queryKey: ["rewards", mode, clientId, page],
    queryFn: () => api().rewards.statement(mode, clientId, page),
    refetchOnMount: "always",
    refetchInterval: 30000,
  });
  if (statement.isPending) return <Skeleton className="h-48" />;
  if (statement.isError)
    return <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />;
  const data = statement.data;
  const p = data.policy;
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="space-y-5">
      {!p.enabled ? (
        <p role="status">{t("loyalty.disabled")}</p>
      ) : (
        <p>
          {t("loyalty.terms", {
            count: p.pointsPerStep,
            amount: formatMoney(p.earnEveryCents, "EUR", locale),
            value: formatMoney(p.redeemValueCents, "EUR", locale),
            maximum: p.maximumDiscountBasisPoints / 100,
          })}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {(
          [
            ["loyalty.available", data.availablePoints],
            ["loyalty.reserved", data.reservedPoints],
            ["loyalty.debt", data.debtPoints],
            ["loyalty.expiring", data.expiringPoints],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-4">
            <dt className="text-sm text-muted">{t(label)}</dt>
            <dd className="mt-1 font-display text-2xl">{number.format(value)}</dd>
          </div>
        ))}
      </dl>
      {data.debtPoints > 0 && <p className="text-sm text-muted">{t("loyalty.debtHelp")}</p>}
      {canAdjust && clientId && p.enabled && <PointAdjustment clientId={clientId} />}
      <h3 className="font-semibold">{t("loyalty.history")}</h3>
      {!data.movements.length ? (
        <EmptyState title={t("loyalty.empty")} />
      ) : (
        <ul className="divide-y divide-line">
          {data.movements.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium">
                  {t(movementKeys[m.kind as keyof typeof movementKeys] ?? "loyalty.activity")}
                </p>
                <p className="text-sm text-muted">
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone,
                  }).format(new Date(m.createdAt))}
                </p>
              </div>
              <p className="font-semibold tabular-nums">
                {new Intl.NumberFormat(locale, { signDisplay: "always" }).format(m.points)}
              </p>
              {m.checkoutId && (
                <Button variant="ghost" onClick={() => setReceipt(m.checkoutId)}>
                  {t("commerce.receipt")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
          {t("inventory.previous")}
        </Button>
        <span>{page}</span>
        <Button
          variant="secondary"
          disabled={page * 20 >= data.pagination.total}
          onClick={() => setPage(page + 1)}
        >
          {t("inventory.next")}
        </Button>
      </div>
      <Sheet
        open={receipt !== null}
        onOpenChange={(open) => {
          if (!open) setReceipt(null);
        }}
        title={t("commerce.receipt")}
        size="lg"
      >
        {receipt && <CheckoutPanel id={receipt} mode={mode} role={role} />}
      </Sheet>
    </div>
  );
}
function PointAdjustment({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const amount = /^-?\d+$/.test(points) ? Number(points) : 0;
  const valid =
    Number.isInteger(amount) &&
    amount !== 0 &&
    Math.abs(amount) <= 1000000 &&
    reason.trim().length >= 8;
  const adjust = useMutation({
    mutationFn: () =>
      api().rewards.adjust(clientId, {
        points: amount,
        reason: reason.trim(),
        idempotencyKey: key,
      }),
    onSuccess: () => {
      setPoints("");
      setReason("");
      setKey(crypto.randomUUID());
      void queries.invalidateQueries({ queryKey: ["rewards"] });
    },
  });
  function changed() {
    setKey(crypto.randomUUID());
    adjust.reset();
  }
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      aria-label={t("loyalty.adjustment")}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) adjust.mutate();
      }}
    >
      <h3 className="font-semibold">{t("loyalty.adjustment")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("loyalty.adjustPoints")}
          value={points}
          inputMode="text"
          onChange={(e) => {
            setPoints(e.target.value);
            changed();
          }}
        />
        <TextField
          label={t("loyalty.reason")}
          value={reason}
          maxLength={300}
          onChange={(e) => {
            setReason(e.target.value);
            changed();
          }}
        />
      </div>
      <Button type="submit" disabled={!online || !valid || adjust.isPending}>
        {t("loyalty.record")}
      </Button>
      {adjust.isError && <p role="alert">{t("loyalty.error")}</p>}
      {adjust.isSuccess && <p role="status">{t("loyalty.adjusted")}</p>}
    </form>
  );
}
