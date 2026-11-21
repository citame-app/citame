import { type LoyaltyPolicy, loyaltyPolicyInputSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
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
const policyKey = ["rewards", "policy"] as const;

export function LoyaltyPolicyForm() {
  const query = useQuery({
    queryKey: policyKey,
    queryFn: () => api().rewards.policy(),
  });
  if (query.isPending) return <Skeleton className="h-48" />;
  if (query.data === undefined)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <ProgramEditor initial={query.data} />;
}
function ProgramEditor({ initial }: { initial: LoyaltyPolicy }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<{ base: LoyaltyPolicy; form: ReturnType<typeof toForm> }>();
  const [invalid, setInvalid] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number>();
  const base = draft?.base ?? initial;
  const form = draft?.form ?? toForm(initial);
  const dirty = draft !== undefined;
  const stale = dirty && base.version !== initial.version;
  const setForm = (next: typeof form) => {
    setDraft(
      JSON.stringify(next) === JSON.stringify(toForm(base)) ? undefined : { base, form: next },
    );
    setInvalid(false);
  };
  const reset = () => {
    setDraft(undefined);
    setInvalid(false);
  };
  const save = useMutation({
    mutationFn: (p: LoyaltyPolicy) => api().rewards.savePolicy(p),
    onSuccess: (p) => {
      queries.setQueryData<LoyaltyPolicy>(policyKey, (current) =>
        current && current.version > p.version ? current : p,
      );
      reset();
      setSavedVersion(p.version);
      void queries.invalidateQueries({ queryKey: ["rewards"] });
    },
  });
  const reload = useMutation({
    mutationFn: () => api().rewards.policy(),
    onSuccess: (p) => {
      queries.setQueryData(policyKey, p);
      reset();
      save.reset();
      setSavedVersion(undefined);
    },
  });
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
        if (!online || !dirty || stale || save.isPending || reload.isPending) return;
        setSavedVersion(undefined);
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
        if (input.success) save.mutate(input.data);
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
          disabled={save.isPending || reload.isPending}
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
            disabled={save.isPending || reload.isPending}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          />
        ))}
      </div>
      {(invalid || save.isError || reload.isError) && <p role="alert">{t("loyalty.error")}</p>}
      {stale && <p role="status">{t("loyalty.policyChanged")}</p>}
      {savedVersion === initial.version && !dirty && <p role="status">{t("loyalty.saved")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={!online || !dirty || stale || save.isPending || reload.isPending}
        >
          {t("loyalty.save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!online || save.isPending || reload.isPending}
          onClick={() => reload.mutate()}
        >
          {t("loyalty.reload")}
        </Button>
      </div>
    </form>
  );
}
