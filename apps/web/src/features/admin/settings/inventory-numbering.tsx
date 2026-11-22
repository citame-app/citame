import {
  INVENTORY_NUMBER_MAX,
  type InventoryNumberingSeries,
  type InventoryNumberingSnapshot,
} from "@sob/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type SetStateAction, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";

const key = ["admin", "settings", "inventory-numbering"] as const;
const series = ["orders", "receipts"] as const;
type Draft = { text: string; next: number; generation: string };

export function InventoryNumbering() {
  const { t } = useI18n();
  const online = useOnline();
  const [drafts, setDrafts] = useState<Record<InventoryNumberingSeries, Draft | null>>({
    orders: null,
    receipts: null,
  });
  const query = useQuery({
    queryKey: key,
    queryFn: () => api().admin.settings.inventoryNumbering(),
  });
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Skeleton className="h-48" />
    );
  const snapshot = query.data;
  return (
    <section className="max-w-2xl space-y-4" aria-labelledby="inventory-numbering-heading">
      <h2 id="inventory-numbering-heading" className="text-heading">
        {t("settings.numbering.title")}
      </h2>
      <p className="text-sm text-muted">{t("settings.numbering.help")}</p>
      <UnsavedGuard dirty={Boolean(drafts.orders || drafts.receipts)} preserveOnSearchChange />
      {!online && <p role="status">{t("settings.numbering.offline")}</p>}
      {series.map((series) => (
        <SeriesEditor
          key={series}
          series={series}
          snapshot={snapshot}
          draft={drafts[series]}
          setDraft={(update) =>
            setDrafts((previous) => ({
              ...previous,
              [series]: typeof update === "function" ? update(previous[series]) : update,
            }))
          }
          online={online}
          reload={async () => (await query.refetch({ throwOnError: true })).data}
          refresh={() => void query.refetch()}
        />
      ))}
    </section>
  );
}

function SeriesEditor({
  series,
  snapshot,
  draft,
  setDraft,
  online,
  reload,
  refresh,
}: {
  series: InventoryNumberingSeries;
  snapshot: InventoryNumberingSnapshot;
  draft: Draft | null;
  setDraft: (update: SetStateAction<Draft | null>) => void;
  online: boolean;
  reload: () => Promise<InventoryNumberingSnapshot | undefined>;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);
  const state = snapshot[series];
  const current = state.nextNumber;
  const reloadSeries = useMutation({
    mutationFn: reload,
    onSuccess: (latest) => {
      const next = latest?.[series].nextNumber;
      if (!latest) return;
      setDraft((value) =>
        value && next != null ? { ...value, next, generation: latest.generation } : null,
      );
      setInvalid(false);
      save.reset();
    },
  });
  const save = useMutation({
    mutationFn: ({ base, value }: { base: Draft; value: number }) =>
      api().admin.settings.advanceInventoryNumbering(series, {
        generation: base.generation,
        expectedNextNumber: base.next,
        nextNumber: value,
      }),
    onSuccess: () => {
      setDraft(null);
      toast.success(t("settings.saved"));
      refresh();
    },
  });
  const conflict =
    (draft && (draft.generation !== snapshot.generation || draft.next !== current)) ||
    (save.error instanceof ApiError && save.error.code === "version_conflict");
  const waiting = save.isPending || reloadSeries.isPending;
  return (
    <form
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-line p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!online || waiting || !draft || conflict || current === null) return;
        const value = Number(draft.text);
        if (
          !/^\d+$/.test(draft.text) ||
          !Number.isInteger(value) ||
          value < current ||
          value > INVENTORY_NUMBER_MAX
        ) {
          setInvalid(true);
          inputRef.current?.focus();
          return;
        }
        save.mutate({ base: draft, value });
      }}
    >
      <h3 id={headingId} className="font-medium">
        {t(`settings.numbering.${series}`)}
      </h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted">{t("settings.numbering.last")}</dt>
          <dd className="tabular-nums">{state.lastIssuedNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("settings.numbering.next")}</dt>
          <dd className="tabular-nums">{current ?? "—"}</dd>
        </div>
      </dl>
      {current === null ? (
        <p role="status">{t("settings.numbering.exhausted")}</p>
      ) : (
        <TextField
          ref={inputRef}
          required
          label={t("settings.numbering.advanceTo")}
          name={`next-${series}`}
          type="text"
          inputMode="numeric"
          maxLength={10}
          autoComplete="off"
          value={draft?.text ?? ""}
          disabled={waiting}
          error={invalid ? t("settings.numbering.invalid") : undefined}
          onChange={(event) => {
            setInvalid(false);
            const text = event.currentTarget.value;
            setDraft((previous) =>
              text
                ? {
                    next: previous?.next ?? current,
                    generation: previous?.generation ?? snapshot.generation,
                    text,
                  }
                : null,
            );
            if (!text) save.reset();
          }}
        />
      )}
      {conflict && (
        <p role="alert" className="text-danger-fg text-sm">
          {t("settings.numbering.conflict")}
        </p>
      )}
      {((save.isError && !conflict) || reloadSeries.isError) && (
        <p role="alert" className="text-danger-fg text-sm">
          {t(describeProblem(reloadSeries.error ?? save.error).messageKey)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {current !== null && (
          <Button type="submit" disabled={!online || waiting || !draft || Boolean(conflict)}>
            {t("settings.numbering.save")}
          </Button>
        )}
        {conflict && (
          <Button
            type="button"
            variant="secondary"
            disabled={!online || waiting}
            onClick={() => reloadSeries.mutate()}
          >
            {t("settings.numbering.review")}
          </Button>
        )}
      </div>
    </form>
  );
}
