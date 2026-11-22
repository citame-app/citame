import type { AppointmentProfitabilityRow, SalesReportQuery } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { UnsavedGuard } from "../unsaved-guard";
import { BreakdownPager, FinancialBreakdown, type Heading } from "./financial-breakdowns";
import { centsInput, inputCents } from "./money";

const queryScope = ["accounting", "appointment-profitability"] as const;

export function AppointmentProfitability({
  range,
  headingLevel,
  paging,
}: {
  range: SalesReportQuery;
  headingLevel: Heading;
  paging?: { page: number; setPage: (page: number) => void };
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState((paging?.page ?? 1) > 1);
  const [editing, setEditing] = useState(false);
  return (
    <section className="space-y-3">
      <Button
        type="button"
        variant="secondary"
        aria-expanded={open}
        disabled={editing}
        onClick={() => setOpen(!open)}
      >
        {t("accounting.profitability.title")}
      </Button>
      {open && (
        <ProfitabilityRows
          range={range}
          headingLevel={headingLevel}
          paging={paging}
          setEditing={setEditing}
        />
      )}
    </section>
  );
}

function ProfitabilityRows({
  range,
  headingLevel,
  paging,
  setEditing,
}: {
  range: SalesReportQuery;
  headingLevel: Heading;
  paging?: { page: number; setPage: (page: number) => void };
  setEditing: (editing: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [localPage, setLocalPage] = useState(1);
  const page = paging?.page ?? localPage;
  const setPage = paging?.setPage ?? setLocalPage;
  const [reviewed, setReviewed] = useState<{
    row: AppointmentProfitabilityRow;
    generation: string;
  } | null>(null);
  const report = useQuery({
    queryKey: [...queryScope, range, page],
    queryFn: () => api().accounting.appointmentProfitability({ ...range, page }),
    refetchInterval: 30_000,
  });
  const review = useQuery({
    queryKey: [...queryScope, range, "review", reviewed?.row.appointmentId],
    queryFn: () =>
      api().accounting.appointmentProfitability({
        ...range,
        page: 1,
        reviewAppointmentId: reviewed?.row.appointmentId,
      }),
    enabled: reviewed !== null,
    refetchInterval: 30_000,
  });
  if (report.isPending) return <Skeleton className="h-32" />;
  const accessDenied = report.error instanceof ApiError && [401, 403].includes(report.error.status);
  if (!report.data || accessDenied)
    return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const { rows, timezone, pagination, generation } = report.data;
  const displayMoney = (cents: number | null | undefined) =>
    cents == null ? "—" : formatMoney(cents, "EUR", locale);
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (range.staffId) params.set("staffId", range.staffId);
  if (range.clientId) params.set("clientId", range.clientId);
  const appointmentLabel = (row: AppointmentProfitabilityRow) => {
    const date = formatDateWithYear(localDateOf(row.startsAt, timezone), locale);
    const time = formatTime(row.startsAt, timezone, locale);
    return [[date, time].join(" "), row.staffName, row.checkoutId.slice(-8)]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <>
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {review.isError && <ErrorState error={review.error} onRetry={() => void review.refetch()} />}
      {reviewed && (
        <CostEditor
          key={reviewed.row.appointmentId}
          initial={reviewed.row}
          initialGeneration={reviewed.generation}
          latestGeneration={review.data?.generation ?? reviewed.generation}
          latest={review.isError ? undefined : (review.data?.reviewed ?? undefined)}
          missing={review.data?.reviewed === null}
          title={appointmentLabel(reviewed.row)}
          reload={() => void review.refetch()}
          close={() => {
            setReviewed(null);
            setEditing(false);
          }}
        />
      )}
      <FinancialBreakdown
        headingLevel={headingLevel}
        title={t("accounting.profitability.title")}
        basis={t("accounting.profitability.basis")}
        empty={t("accounting.profitability.empty")}
        labelColumn={t("accounting.profitability.appointment")}
        columns={[
          t("accounting.profitability.netSales"),
          t("accounting.cost"),
          t("accounting.profitability.commission"),
          t("accounting.profitability.labour"),
          t("accounting.profitability.materials"),
          t("accounting.profitability.margin"),
        ]}
        actionColumn={t("accounting.profitability.costs")}
        stackWhenNarrow
        summary={
          pagination.total > 0 && (
            <a
              href={`/api/admin/accounting/appointment-profitability/export?${params}`}
              className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline"
            >
              {t("accounting.profitability.export")}
            </a>
          )
        }
        rows={rows.map((row) => ({
          key: row.checkoutId,
          label: appointmentLabel(row),
          values: [
            displayMoney(row.netSalesCents),
            row.unknownProductLines
              ? t("accounting.profitability.costsPending", {
                  amount: displayMoney(row.productCostCents),
                  count: row.unknownProductLines,
                })
              : displayMoney(row.productCostCents),
            displayMoney(row.commissionCents),
            displayMoney(row.directCosts?.labourCents),
            displayMoney(row.directCosts?.materialsCents),
            row.reviewReason
              ? t(`accounting.profitability.${row.reviewReason}`)
              : displayMoney(row.marginCents),
          ],
          action: (
            <Button
              type="button"
              variant="ghost"
              disabled={reviewed !== null || report.isError}
              onClick={() => {
                setReviewed({ row, generation });
                setEditing(true);
              }}
            >
              {t("accounting.profitability.edit")}
            </Button>
          ),
        }))}
      />
      <BreakdownPager
        page={page - 1}
        pageCount={Math.ceil(pagination.total / pagination.pageSize)}
        setPage={(next) => setPage(next + 1)}
        disabled={reviewed !== null || report.isError}
        previous={t("table.previous")}
        next={t("table.next")}
      />
    </>
  );
}

function CostEditor({
  initial,
  initialGeneration,
  latestGeneration,
  latest,
  missing,
  title,
  reload,
  close,
}: {
  initial: AppointmentProfitabilityRow;
  initialGeneration: string;
  latestGeneration: string;
  latest: AppointmentProfitabilityRow | undefined;
  missing: boolean;
  title: string;
  reload: () => void;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const toast = useToast();
  const inputValue = (value: number | null | undefined) => (value == null ? "" : centsInput(value));
  const [baseline, setBaseline] = useState(() => ({
    labour: inputValue(initial.directCosts?.labourCents),
    materials: inputValue(initial.directCosts?.materialsCents),
  }));
  const [labour, setLabour] = useState(baseline.labour);
  const [materials, setMaterials] = useState(baseline.materials);
  const [version, setVersion] = useState(initial.directCosts?.version ?? null);
  const [generation, setGeneration] = useState(initialGeneration);
  const stale =
    latest &&
    ((latest.directCosts?.version ?? null) !== version || latestGeneration !== generation);
  const save = useMutation({
    mutationFn: () =>
      api().accounting.saveAppointmentCosts(initial.appointmentId, {
        version,
        generation,
        labourCents: inputCents(labour),
        materialsCents: inputCents(materials),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryScope });
      toast.success(t("accounting.profitability.saved"));
      close();
    },
  });
  const valid =
    (!labour.trim() || inputCents(labour) !== null) &&
    (!materials.trim() || inputCents(materials) !== null);
  const current = (value: number | null | undefined) =>
    value == null ? "—" : formatMoney(value, "EUR", locale);
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && latest && !stale && !save.isPending) save.mutate();
      }}
    >
      <UnsavedGuard
        dirty={(labour !== baseline.labour || materials !== baseline.materials) && !save.isSuccess}
      />
      <p className="font-semibold">{title}</p>
      {missing && <p role="status">{t("accounting.profitability.notInScope")}</p>}
      <p className="text-sm text-muted">{t("accounting.profitability.costHelp")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("accounting.profitability.labour")}
          value={labour}
          inputMode="decimal"
          onChange={(event) => setLabour(event.target.value)}
        />
        <TextField
          label={t("accounting.profitability.materials")}
          value={materials}
          inputMode="decimal"
          onChange={(event) => setMaterials(event.target.value)}
        />
      </div>
      {stale && (
        <div className="space-y-2 text-sm">
          <p role="status">
            {t("accounting.profitability.changed", {
              labour: current(latest.directCosts?.labourCents),
              materials: current(latest.directCosts?.materialsCents),
            })}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const current = {
                labour: inputValue(latest.directCosts?.labourCents),
                materials: inputValue(latest.directCosts?.materialsCents),
              };
              if (labour === baseline.labour) setLabour(current.labour);
              if (materials === baseline.materials) setMaterials(current.materials);
              setBaseline(current);
              setVersion(latest.directCosts?.version ?? null);
              setGeneration(latestGeneration);
              save.reset();
            }}
          >
            {t("accounting.profitability.review")}
          </Button>
        </div>
      )}
      {save.isError && <ErrorState error={save.error} onRetry={reload} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || !latest || !!stale || save.isPending}>
          {t("accounting.profitability.save")}
        </Button>
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={close}>
          {t("accounting.profitability.cancel")}
        </Button>
      </div>
    </form>
  );
}
