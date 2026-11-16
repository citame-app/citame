import type { StaffCapacity } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { usePolicySubmission } from "../policy-submission";
import { UnsavedGuard } from "../unsaved-guard";
export function CapacityPanel({ staffId, editable }: { staffId: string; editable: boolean }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: ["admin", "staff-capacity", staffId],
    queryFn: () => api().schedulingPolicy.capacity(staffId),
    gcTime: 0,
  });
  const reload = async () => {
    const result = await query.refetch();
    if (result.isSuccess) setRevision((v) => v + 1);
  };
  return (
    <section
      aria-label={t("timing.capacityTitle")}
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <h3 className="font-semibold">{t("timing.capacityTitle")}</h3>
      <p className="max-w-prose text-sm text-muted">{t("timing.capacityHelp")}</p>
      {saved && <p role="status">{t("timing.saved")}</p>}
      {query.isPending ? (
        <Skeleton className="h-24" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void reload()} />
      ) : (
        <CapacityForm
          key={`${staffId}-${revision}`}
          data={query.data}
          editable={editable}
          onReload={reload}
          onSaved={async (result) => {
            client.setQueryData(["admin", "staff-capacity", staffId], result);
            setRevision((v) => v + 1);
            setSaved(true);
            void client.invalidateQueries({ queryKey: ["availability"] });
            void client.invalidateQueries({ queryKey: ["admin", "calendar"] });
            void client.invalidateQueries({ queryKey: ["admin", "staff"] });
          }}
        />
      )}
    </section>
  );
}
function CapacityForm({
  data,
  editable,
  onReload,
  onSaved,
}: {
  data: StaffCapacity;
  editable: boolean;
  onReload: () => Promise<void>;
  onSaved: (result: StaffCapacity) => Promise<void>;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const initial = useRef(data).current;
  const [capacity, setCapacity] = useState(String(initial.maxConcurrent));
  const [confirmed, setConfirmed] = useState(false);
  const [discard, setDiscard] = useState(false);
  const change = {
    maxConcurrent: Number(capacity),
    version: initial.version,
    confirmed: true as const,
  };
  const { mutation, disabled, uncertain, changed } = usePolicySubmission(
    change,
    (input) => api().schedulingPolicy.setCapacity(initial.staffId, input),
    onSaved,
  );
  const dirty = capacity !== String(initial.maxConcurrent) || confirmed || uncertain;
  const reload = () => {
    if (dirty) setDiscard(true);
    else void onReload();
  };
  const occupied = mutation.error instanceof ApiError && mutation.error.code === "slot_taken";
  return (
    <>
      <UnsavedGuard dirty={dirty || mutation.isPending} />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <SelectField
          label={t("timing.capacity")}
          value={capacity}
          disabled={!editable || disabled}
          options={Array.from({ length: 6 }, (_, i) => ({
            value: String(i + 1),
            label: String(i + 1),
          }))}
          onChange={(value) => {
            setCapacity(value);
            setConfirmed(false);
            changed();
          }}
        />
        {!editable && <p className="text-sm text-muted">{t("timing.readOnly")}</p>}
        {editable && (
          <>
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1.5"
                checked={confirmed}
                disabled={disabled}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  changed();
                }}
              />
              <span>{t("timing.capacityConfirm")}</span>
            </label>
            {uncertain && (
              <p role="alert" className="rounded-lg bg-warning-soft p-4 text-warning-fg">
                {t("timing.uncertain")}
              </p>
            )}
            {mutation.isError && !uncertain && (
              <p role="alert" className="text-danger-fg">
                {t(occupied ? "timing.occupied" : "timing.failed")}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                loading={mutation.isPending}
                disabled={
                  !online ||
                  mutation.isPending ||
                  (!uncertain && (!confirmed || capacity === String(initial.maxConcurrent)))
                }
              >
                {t(uncertain ? "timing.retry" : "timing.saveCapacity")}
              </Button>
              <Button variant="ghost" disabled={mutation.isPending} onClick={reload}>
                {t("timing.reload")}
              </Button>
            </div>
          </>
        )}
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
