import {
  type LoyaltyPolicy,
  loyaltyPolicyInputSchema,
  type ReviewedLoyaltyPolicy,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { loyaltyPolicyQueryKey } from "~/lib/api/reward-endpoints";
import { UnsavedGuard } from "../unsaved-guard";
import { centsInput, inputCents } from "./money";

const toForm = (p: LoyaltyPolicy) => ({
  enabled: p.enabled,
  earnEveryCents: centsInput(p.earnEveryCents),
  pointsPerStep: String(p.pointsPerStep),
  redeemValueCents: centsInput(p.redeemValueCents),
  maximumDiscountBasisPoints: centsInput(p.maximumDiscountBasisPoints),
  expiryDays: p.expiryDays === null ? "" : String(p.expiryDays),
});
const policyQuery = {
  queryKey: loyaltyPolicyQueryKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => api().rewards.policy(signal),
};

export function LoyaltyPolicyForm() {
  const query = useQuery(policyQuery);
  if (query.isPending) return <Skeleton className="h-48" />;
  if (query.data === undefined)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <ProgramEditor initial={query.data} />;
}
function ProgramEditor({ initial }: { initial: ReviewedLoyaltyPolicy }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<{
    base: ReviewedLoyaltyPolicy;
    form: ReturnType<typeof toForm>;
  }>();
  const [pending, setPending] = useState<ReviewedLoyaltyPolicy>();
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState<ReviewedLoyaltyPolicy>();
  const base = draft?.base ?? initial;
  const form = draft?.form ?? toForm(initial);
  const dirty = draft !== undefined;
  const stale =
    dirty && (base.version !== initial.version || base.generation !== initial.generation);
  const canReplay =
    pending !== undefined &&
    pending.generation === initial.generation &&
    initial.version === pending.version + 1 &&
    JSON.stringify(toForm(initial)) === JSON.stringify(toForm(pending));
  const setForm = (next: typeof form) => {
    setDraft(
      JSON.stringify(next) === JSON.stringify(toForm(base)) ? undefined : { base, form: next },
    );
    setInvalid(false);
  };
  const reset = () => {
    setDraft(undefined);
    setPending(undefined);
    setInvalid(false);
  };
  const save = useMutation({
    mutationFn: (p: ReviewedLoyaltyPolicy) => api().rewards.savePolicy(p),
    onSuccess: (p) => {
      const current = queries.getQueryData<ReviewedLoyaltyPolicy>(loyaltyPolicyQueryKey);
      if (current && current.generation !== p.generation) {
        setPending(undefined);
        return;
      }
      queries.setQueryData<ReviewedLoyaltyPolicy>(loyaltyPolicyQueryKey, (current) =>
        current && current.version > p.version ? current : p,
      );
      reset();
      setSaved(p);
      void queries.invalidateQueries({ queryKey: ["rewards"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status < 500 && error.status !== 408)
        setPending(undefined);
    },
  });
  const reload = useMutation({
    mutationFn: () => queries.fetchQuery({ ...policyQuery, staleTime: 0 }),
    onSuccess: () => {
      reset();
      save.reset();
      setSaved(undefined);
    },
  });
  const busy = save.isPending || reload.isPending;
  const canSubmit = online && dirty && (!stale || canReplay) && !busy;
  const fields = [
    ["earnEveryCents", "loyalty.earnEvery"],
    ["pointsPerStep", "loyalty.earnPoints"],
    ["redeemValueCents", "loyalty.pointValue"],
    ["maximumDiscountBasisPoints", "loyalty.maximum"],
    ["expiryDays", "loyalty.expiry"],
  ] as const;
  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-surface p-5"
      aria-label={t("loyalty.program")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSaved(undefined);
        if (pending) {
          save.mutate(pending);
          return;
        }
        const input = loyaltyPolicyInputSchema.safeParse({
          enabled: form.enabled,
          earnEveryCents: inputCents(form.earnEveryCents),
          pointsPerStep: /^\d+$/.test(form.pointsPerStep) ? Number(form.pointsPerStep) : null,
          redeemValueCents: inputCents(form.redeemValueCents),
          maximumDiscountBasisPoints: inputCents(form.maximumDiscountBasisPoints),
          expiryDays:
            form.expiryDays.trim() === ""
              ? null
              : /^\d+$/.test(form.expiryDays)
                ? Number(form.expiryDays)
                : false,
          version: base.version,
        });
        setInvalid(!input.success);
        if (input.success) {
          const submission = { ...input.data, generation: base.generation };
          setPending(submission);
          save.mutate(submission);
        }
      }}
    >
      <UnsavedGuard dirty={dirty} />
      <h3 className="text-heading">{t("loyalty.program")}</h3>
      <p className="text-sm text-muted">{t("loyalty.programHelp")}</p>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          name="enabled"
          className="size-5 accent-accent"
          checked={form.enabled}
          disabled={busy || pending !== undefined}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        {t("loyalty.enabled")}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label]) => (
          <TextField
            key={key}
            name={key}
            label={t(label)}
            inputMode={key === "pointsPerStep" || key === "expiryDays" ? "numeric" : "decimal"}
            value={form[key]}
            disabled={busy || pending !== undefined}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          />
        ))}
      </div>
      {(invalid || save.isError || reload.isError) && (
        <p role="alert">{t(pending ? "loyalty.policyUnconfirmed" : "loyalty.error")}</p>
      )}
      {stale && !canReplay && <p role="status">{t("loyalty.policyChanged")}</p>}
      {saved?.version === initial.version && saved.generation === initial.generation && !dirty && (
        <p role="status">{t("loyalty.saved")}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!canSubmit}>
          {t(pending && !busy ? "loyalty.policyRetry" : "loyalty.save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!online || busy}
          onClick={() => reload.mutate()}
        >
          {t("loyalty.reload")}
        </Button>
      </div>
    </form>
  );
}
