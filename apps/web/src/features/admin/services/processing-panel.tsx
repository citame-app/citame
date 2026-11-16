import { type AdminService, serviceProcessingInputSchema } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { adminServicesQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration } from "~/lib/format";
import { usePolicySubmission } from "../policy-submission";
import { UnsavedGuard } from "../unsaved-guard";
export function ProcessingPanel() {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery(adminServicesQuery);
  const [selected, setSelected] = useState("");
  const [next, setNext] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const reloadTicket = useRef(0);
  const service = query.data?.find((s) => s.id === selected);
  const reload = async () => {
    const id = selected;
    const ticket = ++reloadTicket.current;
    const result = await query.refetch();
    if (result.isSuccess && selectedRef.current === id && reloadTicket.current === ticket) {
      setRevision((v) => v + 1);
      setDirty(false);
      setBusy(false);
    }
  };
  const choose = (id: string) => {
    if (dirty) setNext(id);
    else {
      setSelected(id);
      setSaved(false);
    }
  };
  return (
    <section
      id="processing-settings"
      aria-label={t("timing.processingTitle")}
      className="mt-10 scroll-mt-24 space-y-5 border-t border-line pt-8"
    >
      <h2 className="text-heading">{t("timing.processingTitle")}</h2>
      <p className="max-w-prose text-muted">{t("timing.processingHelp")}</p>
      {query.isPending ? (
        <Skeleton className="h-24" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void reload()} />
      ) : (
        <SelectField
          label={t("timing.chooseService")}
          value={selected}
          disabled={busy}
          options={[
            { value: "", label: t("timing.chooseService") },
            ...query.data.map((row) => ({ value: row.id, label: row.name })),
          ]}
          onChange={choose}
        />
      )}
      {saved && <p role="status">{t("timing.saved")}</p>}
      {service && (
        <ProcessingEditor
          key={`${selected}-${revision}`}
          service={service}
          onDirtyChange={setDirty}
          onBusyChange={setBusy}
          onReload={reload}
          onSaved={async (result) => {
            client.setQueryData(adminServicesQuery.queryKey, (rows: AdminService[] | undefined) =>
              (rows ?? []).map((row) => (row.id === result.id ? result : row)),
            );
            if (selectedRef.current !== result.id) return;
            setRevision((v) => v + 1);
            setSaved(true);
            void client.invalidateQueries({ queryKey: ["services"] });
            void client.invalidateQueries({ queryKey: ["availability"] });
          }}
        />
      )}
      <ConfirmDialog
        open={next !== undefined}
        onOpenChange={(open) => {
          if (!open) setNext(undefined);
        }}
        destructive
        title={t("timing.discardTitle")}
        description={t("timing.discardBody")}
        confirmLabel={t("timing.discardAction")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => {
          setSelected(next ?? "");
          setNext(undefined);
          setDirty(false);
          setBusy(false);
          setSaved(false);
        }}
      />
    </section>
  );
}
export function ProcessingEditor({
  service,
  onReload,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  service: AdminService;
  onReload: () => Promise<void>;
  onSaved: (result: AdminService) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const initial = useRef(service).current;
  const [enabled, setEnabled] = useState(Boolean(initial.processing));
  const [before, setBefore] = useState(
    initial.processing ? String(initial.processing.startsAfterMinutes) : "",
  );
  const [exposure, setExposure] = useState(
    initial.processing ? String(initial.processing.minutes) : "",
  );
  const [discard, setDiscard] = useState(false);
  const input = {
    version: initial.version ?? 1,
    processing: enabled ? { startsAfterMinutes: Number(before), minutes: Number(exposure) } : null,
  };
  const valid =
    serviceProcessingInputSchema.safeParse(input).success &&
    (!input.processing ||
      input.processing.startsAfterMinutes + input.processing.minutes < initial.durationMinutes);
  const dirty =
    enabled !== Boolean(initial.processing) ||
    before !== (initial.processing ? String(initial.processing.startsAfterMinutes) : "") ||
    exposure !== (initial.processing ? String(initial.processing.minutes) : "");
  const { mutation, disabled, uncertain, changed } = usePolicySubmission(
    input,
    (packet) => api().schedulingPolicy.setProcessing(initial.id, packet),
    onSaved,
  );
  useEffect(() => {
    onDirtyChange?.(dirty || uncertain);
  }, [dirty, uncertain, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(disabled);
  }, [disabled, onBusyChange]);
  const reload = () => {
    if (dirty || uncertain) setDiscard(true);
    else void onReload();
  };
  const finish = initial.durationMinutes - Number(before) - Number(exposure);
  return (
    <>
      <UnsavedGuard dirty={dirty || mutation.isPending || uncertain} />
      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid || uncertain) mutation.mutate();
        }}
      >
        <p className="font-medium">
          {initial.name} · {formatDuration(initial.durationMinutes, locale)}
        </p>
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            className="mt-1.5"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              changed();
            }}
          />
          <span>{t("timing.enableProcessing")}</span>
        </label>
        {enabled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label={t("timing.before")}
              type="number"
              min={1}
              max={initial.durationMinutes - 2}
              value={before}
              disabled={disabled}
              onChange={(event) => {
                setBefore(event.target.value);
                changed();
              }}
            />
            <TextField
              label={t("timing.exposure")}
              type="number"
              min={1}
              max={initial.durationMinutes - 2}
              value={exposure}
              disabled={disabled}
              onChange={(event) => {
                setExposure(event.target.value);
                changed();
              }}
            />
            <TextField
              label={t("timing.after")}
              value={valid && before && exposure ? String(finish) : "—"}
              readOnly
            />
          </div>
        )}
        {enabled && !valid && (
          <p role="status" className="text-sm text-muted">
            {t("timing.processingInvalid")}
          </p>
        )}
        {uncertain && (
          <p role="alert" className="rounded-lg bg-warning-soft p-4 text-warning-fg">
            {t("timing.uncertain")}
          </p>
        )}
        {mutation.isError && !uncertain && (
          <p role="alert" className="text-danger-fg">
            {t("timing.failed")}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!online || mutation.isPending || (!uncertain && (!valid || !dirty))}
          >
            {t(uncertain ? "timing.retry" : "timing.saveProcessing")}
          </Button>
          <Button variant="ghost" disabled={mutation.isPending} onClick={reload}>
            {t("timing.reload")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        destructive
        title={t("timing.discardTitle")}
        description={t(uncertain ? "timing.uncertain" : "timing.discardBody")}
        confirmLabel={t("timing.reload")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => void onReload()}
      />
    </>
  );
}
