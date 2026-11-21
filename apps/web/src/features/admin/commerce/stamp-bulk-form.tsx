import {
  type StampBulkInput,
  type StampBulkReview,
  type StampBulkScope,
  stampBulkInputSchema,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";

const scopeLabels = {
  expired: "stamps.bulkScopeExpired",
  completed: "stamps.bulkScopeCompleted",
  all: "stamps.bulkScopeAll",
} as const satisfies Record<StampBulkScope, string>;

export function StampBulkForm() {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const heading = useId();
  const reasonId = useId();
  const [scope, setScope] = useState<StampBulkScope>("expired");
  const [reason, setReason] = useState("");
  const [review, setReview] = useState<StampBulkReview>();
  const [packet, setPacket] = useState<StampBulkInput>();
  const [changed, setChanged] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const prepare = useMutation({
    mutationFn: (value: StampBulkScope) => api().rewards.reviewStampBatch(value),
    onSuccess: (next) => {
      setReview(next);
      setChanged(false);
    },
  });
  const apply = useMutation({
    mutationFn: async (input: StampBulkInput) => {
      const receipt = await api().rewards.voidStampBatch(input);
      if (
        receipt.idempotencyKey !== input.idempotencyKey ||
        receipt.generation !== input.generation ||
        receipt.scope !== input.scope ||
        receipt.total !== review?.total
      )
        throw new Error("Unexpected stamp card batch acknowledgement");
      return receipt;
    },
    onSuccess: () => {
      setReview(undefined);
      setPacket(undefined);
      setReason("");
      void queries.invalidateQueries({ queryKey: ["rewards", "stamps"] });
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        ![401, 403, 408, 429].includes(error.status)
      ) {
        setPacket(undefined);
        if (error.status === 409) {
          setReview(undefined);
          setChanged(true);
        }
      }
    },
  });
  const busy = prepare.isPending || apply.isPending;
  return (
    <details className="rounded-xl border border-line bg-surface p-4">
      <summary className="cursor-pointer font-semibold">{t("stamps.bulkTitle")}</summary>
      <form
        aria-labelledby={heading}
        className="mt-4 max-w-xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || busy) return;
          if (packet) {
            apply.mutate(packet);
          } else if (!review) {
            apply.reset();
            prepare.mutate(scope);
          } else if (review.total > 0) {
            const validated = stampBulkInputSchema.safeParse({
              scope: review.scope,
              generation: review.generation,
              reviewFingerprint: review.reviewFingerprint,
              reason,
              idempotencyKey: crypto.randomUUID(),
            });
            setInvalid(!validated.success);
            if (validated.success) {
              setPacket(validated.data);
              apply.mutate(validated.data);
            }
          }
        }}
      >
        <UnsavedGuard dirty={Boolean(reason || packet || apply.isPending)} />
        <h3 id={heading} className="text-heading">
          {t(review ? "stamps.bulkReviewTitle" : "stamps.bulkScope")}
        </h3>
        {review ? (
          <p className="text-sm font-semibold">{t(scopeLabels[review.scope])}</p>
        ) : (
          <SelectField
            label={t("stamps.bulkScope")}
            hideLabel
            disabled={busy}
            value={scope}
            options={(["expired", "completed", "all"] as const).map((value) => ({
              value,
              label: t(scopeLabels[value]),
            }))}
            onChange={(value) => {
              setScope(value as StampBulkScope);
              apply.reset();
              prepare.reset();
              setChanged(false);
            }}
          />
        )}
        {changed && <p role="status">{t("stamps.bulkStale")}</p>}
        {prepare.isError && <ErrorState error={prepare.error} />}
        {apply.isError && !changed && <ErrorState error={apply.error} />}
        {apply.isSuccess && (
          <p role="status">
            {t("stamps.bulkSaved")} · {apply.data.total}
          </p>
        )}
        {review &&
          (review.total > 0 ? (
            <>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg bg-sunken p-3 text-sm">
                {(
                  [
                    ["total", "stamps.bulkReviewCount", review.total],
                    ["active", "stamps.bulkActive", review.counts.active],
                    ["completed", "stamps.bulkCompleted", review.counts.completed],
                    ["issued", "stamps.bulkIssued", review.counts.issued],
                    ["expired", "stamps.bulkExpired", review.counts.expired],
                  ] as const
                ).map(([key, label, count]) => (
                  <div className="contents" key={key}>
                    <dt>{t(label)}</dt>
                    <dd className="tabular-nums">{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-danger-fg">{t("stamps.bulkWarning")}</p>
              <label className="grid gap-1 text-sm" htmlFor={reasonId}>
                {t("stamps.bulkReason")}
              </label>
              <textarea
                className="min-h-20 w-full rounded-md border border-line bg-surface p-3"
                id={reasonId}
                disabled={busy || Boolean(packet)}
                value={reason}
                required
                minLength={8}
                maxLength={300}
                aria-invalid={invalid || undefined}
                onChange={(event) => {
                  setReason(event.target.value);
                  setInvalid(false);
                }}
              />
              {invalid && (
                <p role="alert" className="text-danger-fg">
                  {t("stamps.bulkReasonInvalid")}
                </p>
              )}
            </>
          ) : (
            <p>{t("stamps.bulkEmpty")}</p>
          ))}
        <div className="flex flex-wrap gap-2">
          {(!review || review.total > 0) && (
            <Button
              type="submit"
              variant={review ? "danger" : "primary"}
              disabled={!online || busy}
            >
              {t(
                packet ? "stamps.bulkRetry" : review ? "stamps.bulkConfirm" : "stamps.bulkPreview",
              )}
            </Button>
          )}
          {review && !packet && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setReview(undefined);
                setInvalid(false);
                apply.reset();
              }}
            >
              {t("stamps.bulkChange")}
            </Button>
          )}
        </div>
      </form>
    </details>
  );
}
