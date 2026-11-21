import {
  type ReviewedStaffAccess,
  type StaffAccessPreset,
  staffAccessPresetSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

const accessKey = (id: string) => ["admin", "staff-access", id] as const;

export function AccessPanel({ staffId }: { staffId: string }) {
  const { t } = useI18n();
  const access = useQuery({
    queryKey: accessKey(staffId),
    queryFn: ({ signal }) => api().admin.staff.access(staffId, signal),
  });
  return (
    <section
      aria-label={t("access.title")}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h3 className="font-semibold">{t("access.title")}</h3>
      <p className="text-sm text-muted">{t("access.help")}</p>
      {access.data ? (
        <AccessForm
          key={staffId}
          latest={access.data}
          readFailed={access.isError}
          reload={async () => {
            const result = await access.refetch();
            if (result.error) throw result.error;
          }}
        />
      ) : access.isError ? (
        <ErrorState error={access.error} onRetry={() => void access.refetch()} />
      ) : (
        <Skeleton className="h-16" />
      )}
    </section>
  );
}

function sameReview(base: ReviewedStaffAccess, latest: ReviewedStaffAccess) {
  return (
    base.generation === latest.generation &&
    base.accountId === latest.accountId &&
    base.access.version === latest.access.version &&
    base.access.accountRole === latest.access.accountRole &&
    base.access.preset === latest.access.preset
  );
}

function AccessForm({
  latest,
  readFailed,
  reload,
}: {
  latest: ReviewedStaffAccess;
  readFailed: boolean;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const outcomeId = useId();
  const [base, setBase] = useState(latest);
  const [draft, setDraft] = useState<StaffAccessPreset | null>(null);
  const preset = draft ?? base.access.preset;
  const dirty = preset !== base.access.preset;
  const [mustReload, setMustReload] = useState(false);
  const canChange = latest.access.accountRole === null || latest.access.accountRole === "staff";
  const changed = !sameReview(base, latest);
  const fetchReview = useMutation({
    mutationFn: reload,
    onSuccess: () => setMustReload(false),
  });
  const save = useMutation({
    mutationFn: (review: ReviewedStaffAccess) =>
      api().admin.staff.setAccess(review.access.staffId, {
        generation: review.generation,
        accountId: review.accountId,
        version: review.access.version,
        preset,
      }),
    onSuccess: (saved, submitted) => {
      queries.setQueryData<ReviewedStaffAccess>(accessKey(saved.access.staffId), (current) =>
        !current || sameReview(submitted, current) ? saved : current,
      );
      setBase(saved);
      setDraft(null);
      void queries.invalidateQueries({ queryKey: ["admin", "staff"] });
      void queries.invalidateQueries({ queryKey: accessKey(saved.access.staffId) });
    },
    onError: () => setMustReload(true),
  });
  const busy = save.isPending || fetchReview.isPending;
  if (changed && !dirty && !busy) {
    setBase(latest);
    setDraft(null);
  }
  const needsReview = mustReload || readFailed;
  const canSave = online && !busy && !needsReview && !changed && canChange && dirty;
  return (
    <form
      aria-label={t("access.profile")}
      aria-describedby={outcomeId}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate(base);
      }}
    >
      <p className="text-sm">
        {t("access.current", { profile: t(`access.${latest.access.preset}`) })}
      </p>
      {latest.accountEmail && (
        <p className="break-all text-sm">
          {t("access.linkedAccount", { email: latest.accountEmail })}
        </p>
      )}
      {latest.access.accountRole === null && (
        <p className="text-sm text-muted">{t("access.noAccount")}</p>
      )}
      {!canChange && <p className="text-sm text-muted">{t("access.accountRole")}</p>}
      <fieldset disabled={busy || !canChange} className="flex flex-wrap items-end gap-3">
        <legend className="sr-only">{t("access.profile")}</legend>
        <SelectField
          name="preset"
          label={t("access.profile")}
          value={preset}
          options={staffAccessPresetSchema.options.map((value) => ({
            value,
            label: t(`access.${value}`),
          }))}
          onChange={(value) => {
            setDraft(value as StaffAccessPreset);
            save.reset();
          }}
        />
        <Button type="submit" loading={save.isPending} disabled={!canSave}>
          {t("access.save")}
        </Button>
      </fieldset>
      <p id={outcomeId} role="status" className="text-sm">
        {needsReview || fetchReview.isError
          ? t("access.error")
          : changed && dirty
            ? t("access.changed")
            : save.isSuccess
              ? t("access.saved")
              : null}
      </p>
      {needsReview && (
        <Button
          type="button"
          variant="ghost"
          disabled={!online || busy}
          onClick={() => fetchReview.mutate()}
        >
          {t("access.reload")}
        </Button>
      )}
      {changed && dirty && !needsReview && canChange && (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setBase(latest)}>
          {t("access.review")}
        </Button>
      )}
    </form>
  );
}
