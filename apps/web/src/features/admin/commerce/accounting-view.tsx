import type { UserRole } from "@sob/contracts";
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
import { downloadCsv } from "./csv";
import { centsInput, inputCents } from "./money";
export function AccountingView({ role }: { role: UserRole }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState("");
  const staff = useQuery({ ...adminStaffQuery, enabled: role === "owner" });
  const me = useQuery({
    queryKey: ["accounting", "me"],
    queryFn: () => api().me(),
    enabled: role === "staff",
  });
  const staffId = role === "staff" ? me.data?.staffId : selected;
  return (
    <section className="space-y-6" aria-label={t("accounting.title")}>
      <h2 className="text-heading">
        {t(role === "owner" ? "accounting.title" : "accounting.own")}
      </h2>
      {role === "owner" && <SalesReport />}
      {role === "owner" &&
        (staff.isPending ? (
          <Skeleton className="h-14" />
        ) : staff.isError ? (
          <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
        ) : (
          <SelectField
            label={t("accounting.staff")}
            value={selected}
            options={[
              { value: "", label: t("accounting.pick") },
              ...staff.data.map((member) => ({ value: member.id, label: member.displayName })),
            ]}
            onChange={setSelected}
          />
        ))}
      {role === "staff" &&
        (me.isPending ? (
          <Skeleton className="h-14" />
        ) : me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : !me.data.staffId ? (
          <p>{t("accounting.noStaff")}</p>
        ) : null)}
      {staffId && <CommissionPanel key={staffId} staffId={staffId} role={role} />}
    </section>
  );
}
export function CommissionPanel({ staffId, role }: { staffId: string; role: UserRole }) {
  const { t, locale, timeZone } = useI18n();
  const queries = useQueryClient();
  const [page, setPage] = useState(1);
  const [payoutPage, setPayoutPage] = useState(1);
  const statement = useQuery({
    queryKey: ["accounting", "statement", staffId, page, payoutPage],
    queryFn: () => api().accounting.statement(staffId, page, payoutPage),
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
  const policy = useQuery({
    queryKey: ["accounting", "policy", staffId],
    queryFn: () => api().accounting.policy(staffId),
    enabled: role === "owner",
  });
  const money = (value: number) => formatMoney(value, "EUR", locale);
  const changed = () => void queries.invalidateQueries({ queryKey: ["accounting"] });
  if (statement.isPending) return <Skeleton className="h-48" />;
  if (statement.isError)
    return <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />;
  const data = statement.data;
  return (
    <section className="space-y-5" aria-label={t("accounting.commissions")}>
      <h3 className="text-heading">{t("accounting.commissions")}</h3>
      <Button
        variant="secondary"
        disabled={!data.accruals.length}
        onClick={() =>
          downloadCsv(
            [
              [
                "checkout_id",
                "description",
                "kind",
                "basis_cents",
                "rate_basis_points",
                "original_cents",
                "after_refunds_cents",
                "currency",
                "earned_at",
              ],
              ...data.accruals.map((row) => [
                row.checkoutId,
                row.description,
                row.kind,
                row.basisCents,
                row.rateBasisPoints,
                row.originalCents,
                row.adjustedCents,
                "EUR",
                row.createdAt,
              ]),
            ],
            `commissions-${staffId}-page-${page}.csv`,
          )
        }
      >
        {t("accounting.exportCommissions")}
      </Button>
      <Button variant="ghost" onClick={changed}>
        {t("accounting.refresh")}
      </Button>
      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          ["accounting.earned", data.earnedCents],
          ["accounting.paid", data.paidCents],
          ["accounting.outstanding", data.outstandingCents],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-4">
            <dt className="text-sm text-muted">{t(label as "accounting.earned")}</dt>
            <dd className="mt-1 font-display text-xl">{money(Number(value))}</dd>
          </div>
        ))}
      </dl>
      {data.outstandingCents < 0 && (
        <p role="status" className="text-danger-fg">
          {t("accounting.negative")}
        </p>
      )}
      {role === "owner" &&
        (policy.isPending ? (
          <Skeleton className="h-32" />
        ) : policy.isError ? (
          <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
        ) : (
          <RateEditor
            key={`${staffId}-${policy.data.version}`}
            policy={policy.data}
            onSaved={changed}
          />
        ))}
      {role === "owner" && (
        <PayoutForm staffId={staffId} outstanding={data.outstandingCents} onSaved={changed} />
      )}
      {data.accruals.length === 0 ? (
        <EmptyState title={t("accounting.empty")} description={t("accounting.emptyHelp")} />
      ) : (
        <ul className="divide-y divide-line">
          {data.accruals.map((row) => (
            <li key={row.id} className="flex flex-wrap justify-between gap-3 py-3">
              <div>
                <p className="font-medium">{row.description}</p>
                <p className="text-sm text-muted">
                  {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
                    new Date(row.createdAt),
                  )}{" "}
                  · {row.rateBasisPoints / 100}%
                </p>
              </div>
              <div className="text-right text-sm">
                <p>
                  {t("accounting.original")}: {money(row.originalCents)}
                </p>
                <p>
                  {t("accounting.adjusted")}: {money(row.adjustedCents)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pages page={page} total={data.pagination.total} onChange={setPage} />
      <h4 className="font-semibold">{t("accounting.payoutHistory")}</h4>
      <ul className="divide-y divide-line">
        {data.payouts.map((row) => (
          <li key={row.id} className="flex flex-wrap justify-between gap-3 py-3">
            <div>
              <p className="break-words">{row.reference}</p>
              <p className="text-sm text-muted">
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
                  new Date(row.createdAt),
                )}
              </p>
            </div>
            <span>{money(row.amountCents)}</span>
          </li>
        ))}
      </ul>
      <Pages page={payoutPage} total={data.payoutPagination.total} onChange={setPayoutPage} />
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
  onChange: (page: number) => void;
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
function RateEditor({
  policy,
  onSaved,
}: {
  policy: {
    staffId: string;
    serviceBasisPoints: number;
    productBasisPoints: number;
    version: number | null;
  };
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const [service, setService] = useState(centsInput(policy.serviceBasisPoints));
  const [product, setProduct] = useState(centsInput(policy.productBasisPoints));
  const save = useMutation({
    mutationFn: () => {
      const serviceBasisPoints = inputCents(service);
      const productBasisPoints = inputCents(product);
      if (
        serviceBasisPoints === null ||
        productBasisPoints === null ||
        serviceBasisPoints > 10000 ||
        productBasisPoints > 10000
      )
        throw new Error("Invalid rates");
      return api().accounting.setPolicy(policy.staffId, {
        serviceBasisPoints,
        productBasisPoints,
        version: policy.version,
      });
    },
    onSuccess: onSaved,
  });
  return (
    <form
      className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-sm text-muted sm:col-span-2">{t("accounting.rateHelp")}</p>
      <TextField
        label={t("accounting.serviceRate")}
        inputMode="decimal"
        value={service}
        onChange={(e) => {
          setService(e.target.value);
          save.reset();
        }}
      />
      <TextField
        label={t("accounting.productRate")}
        inputMode="decimal"
        value={product}
        onChange={(e) => {
          setProduct(e.target.value);
          save.reset();
        }}
      />
      {save.isError && (
        <p role="alert" className="text-danger-fg">
          {t("accounting.error")}
        </p>
      )}
      <Button type="submit" disabled={!online || save.isPending}>
        {t("accounting.saveRates")}
      </Button>
    </form>
  );
}
function PayoutForm({
  staffId,
  outstanding,
  onSaved,
}: {
  staffId: string;
  outstanding: number;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: () => {
      const amountCents = inputCents(amount);
      if (
        amountCents === null ||
        amountCents <= 0 ||
        amountCents > outstanding ||
        reference.trim().length < 8
      )
        throw new Error("Invalid payout");
      return api().accounting.payout(staffId, {
        amountCents,
        reference: reference.trim(),
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      setAmount("");
      setReference("");
      setKey(crypto.randomUUID());
      onSaved();
    },
  });
  const reset = () => {
    setKey(crypto.randomUUID());
    save.reset();
  };
  return (
    <form
      className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-sm text-muted sm:col-span-2">{t("accounting.payoutHelp")}</p>
      <TextField
        label={t("accounting.payoutAmount")}
        inputMode="decimal"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          reset();
        }}
      />
      <TextField
        label={t("accounting.reference")}
        value={reference}
        onChange={(e) => {
          setReference(e.target.value);
          reset();
        }}
      />
      {save.isError && (
        <p role="alert" className="text-danger-fg">
          {t("accounting.error")}
        </p>
      )}
      {save.isSuccess && <p role="status">{t("accounting.saved")}</p>}
      <Button type="submit" disabled={!online || save.isPending || outstanding <= 0}>
        {t("accounting.recordPayout")}
      </Button>
    </form>
  );
}
function SalesReport() {
  const { t, locale, timeZone } = useI18n();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [range, setRange] = useState({ from: today, to: today });
  const report = useQuery({
    queryKey: ["accounting", "sales", range],
    queryFn: () => api().accounting.sales(range),
    refetchOnMount: "always",
    refetchInterval: 30_000,
  });
  const money = (value: number) => formatMoney(value, "EUR", locale);
  return (
    <section className="space-y-4" aria-label={t("accounting.sales")}>
      <h3 className="text-heading">{t("accounting.sales")}</h3>
      <p className="text-sm text-muted">{t("accounting.reportHelp")}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setRange({ from, to });
        }}
      >
        <TextField
          label={t("accounting.from")}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          required
        />
        <TextField
          label={t("accounting.to")}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
        />
        <Button type="submit">{t("accounting.load")}</Button>
      </form>
      {report.isPending ? (
        <Skeleton className="h-48" />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <>
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                [
                  ["from", "to", "timezone", "metric", "amount_cents", "currency"],
                  ...Object.entries({
                    collected: report.data.collectedCents,
                    refunds: report.data.refundedCents,
                    net_collections: report.data.netCollectedCents,
                    settled_sales: report.data.soldCents,
                    included_tax_at_sale: report.data.includedTaxCents,
                    settled_tips: report.data.tipsCents,
                    known_product_cost_at_sale: report.data.productCostCents,
                    gift_value_applied: report.data.storedValueAppliedCents,
                    gift_value_returned: report.data.storedValueReturnedCents,
                    gift_value_issued: report.data.giftValueIssuedCents,
                    prepaid_visits_face_applied: report.data.prepaidAppliedCents,
                    prepaid_visits_face_returned: report.data.prepaidReturnedCents,
                    prepaid_visits_allocated: report.data.prepaidAllocatedCents,
                    prepaid_visits_allocation_returned: report.data.prepaidAllocationReturnedCents,
                    membership_access_fees: report.data.membershipAccessFeesCents,
                    booking_fees: report.data.bookingFeesCents,
                  }).map(([metric, value]) => [
                    report.data.from,
                    report.data.to,
                    report.data.timezone,
                    metric,
                    value,
                    "EUR",
                  ]),
                  [],
                  ["method", "tender_applied_cents", "tender_returned_cents", "currency"],
                  ...report.data.methods.map((method) => [
                    method.method,
                    method.collectedCents,
                    method.refundedCents,
                    "EUR",
                  ]),
                  [],
                  [
                    "cash_session_id",
                    "opened_at",
                    "closed_at",
                    "opening_cents",
                    "expected_cents",
                    "counted_cents",
                    "difference_cents",
                    "currency",
                  ],
                  ...report.data.cashSessions.map((session) => [
                    session.id,
                    session.openedAt,
                    session.closedAt,
                    session.openingCents,
                    session.expectedCents,
                    session.countedCents,
                    session.differenceCents,
                    "EUR",
                  ]),
                ],
                `financial-summary-${report.data.from}-${report.data.to}.csv`,
              )
            }
          >
            {t("accounting.export")}
          </Button>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["accounting.collected", report.data.collectedCents],
              ["accounting.refunded", report.data.refundedCents],
              ["accounting.net", report.data.netCollectedCents],
              ["accounting.sold", report.data.soldCents],
              ["accounting.tax", report.data.includedTaxCents],
              ["accounting.tips", report.data.tipsCents],
              ["accounting.cost", report.data.productCostCents],
              ["gift.storedApplied", report.data.storedValueAppliedCents],
              ["gift.storedReturned", report.data.storedValueReturnedCents],
              ["gift.issued", report.data.giftValueIssuedCents],
              ["passes.nominalApplied", report.data.prepaidAppliedCents],
              ["passes.nominalReturned", report.data.prepaidReturnedCents],
              ["passes.allocatedApplied", report.data.prepaidAllocatedCents],
              ["passes.allocatedReturned", report.data.prepaidAllocationReturnedCents],
              ["passes.fees", report.data.membershipAccessFeesCents],
              ["protection.feesReport", report.data.bookingFeesCents],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-line bg-surface p-4">
                <dt className="text-sm text-muted">{t(label as "accounting.collected")}</dt>
                <dd className="mt-1 font-display text-xl">{money(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">
            {t("accounting.unknown", { count: report.data.unknownCostLines })}
          </p>
          <ul className="divide-y divide-line">
            {report.data.methods.map((method) => (
              <li key={method.method} className="flex flex-wrap justify-between gap-3 py-2">
                <span>{t(`commerce.${method.method as "cash"}`)}</span>
                <span>
                  {t(method.method === "gift_card" ? "gift.storedApplied" : "accounting.collected")}
                  : {money(method.collectedCents)} ·{" "}
                  {t(method.method === "gift_card" ? "gift.storedReturned" : "accounting.refunded")}
                  : {money(method.refundedCents)}
                </span>
              </li>
            ))}
          </ul>
          <h4 className="font-semibold">{t("accounting.cashHistory")}</h4>
          <ul className="divide-y divide-line">
            {report.data.cashSessions.map((session) => (
              <li key={session.id} className="flex flex-wrap justify-between gap-3 py-3">
                <div>
                  <p>
                    {t("accounting.opened")}:{" "}
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: report.data.timezone,
                    }).format(new Date(session.openedAt))}
                  </p>
                  <p className="text-sm text-muted">
                    {session.closedAt ? t("accounting.closed") : t("commerce.registerOpen")}
                  </p>
                </div>
                <p>
                  {t("accounting.difference")}:{" "}
                  {session.differenceCents === null ? "—" : money(session.differenceCents)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
