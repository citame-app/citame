import {
  type BookingPolicy,
  bookingPolicyInputSchema,
  type ReviewedBookingPolicy,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { centsInput, inputCents } from "../commerce/money";
import { UnsavedGuard } from "../unsaved-guard";

export function BookingPolicyForm() {
  const query = useQuery({
    queryKey: ["admin", "booking-policy"],
    queryFn: ({ signal }) => api().bookingPolicy.admin(signal),
  });
  if (!query.data) {
    if (query.isError)
      return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    return <Skeleton className="h-48" />;
  }
  return <PolicyEditor initial={query.data} />;
}
function policyFields(policy: BookingPolicy) {
  return {
    enabled: policy.enabled,
    kind: policy.depositKind,
    trusted: policy.trustedExempt,
    value: centsInput(policy.depositValue),
    hold: String(policy.holdMinutes),
    window: String(policy.cancellationWindowMinutes),
    late: centsInput(policy.lateCancellationBasisPoints),
    noShow: centsInput(policy.noShowBasisPoints),
  };
}

type PolicyFields = ReturnType<typeof policyFields>;

function sameDecimal(a: string, b: string) {
  const value = inputCents(a);
  return a === b || (value !== null && value === inputCents(b));
}

function PolicyEditor({ initial }: { initial: ReviewedBookingPolicy }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<{ base: ReviewedBookingPolicy; fields: PolicyFields } | null>(
    null,
  );
  const [invalid, setInvalid] = useState(false);
  const [savedVersion, setSavedVersion] = useState<string>();
  const base = draft?.base ?? initial;
  const fields = draft?.fields ?? policyFields(initial.policy);
  const { enabled, kind, trusted, value, hold, window, late, noShow } = fields;
  const input = {
    enabled,
    depositKind: kind,
    depositValue: inputCents(value),
    holdMinutes: Number(hold),
    cancellationWindowMinutes: Number(window),
    lateCancellationBasisPoints: inputCents(late),
    noShowBasisPoints: inputCents(noShow),
    trustedExempt: trusted,
    version: base.policy.version,
  };
  const dirty = JSON.stringify(fields) !== JSON.stringify(policyFields(base.policy));
  const stale =
    dirty &&
    (base.generation !== initial.generation || base.policy.version !== initial.policy.version);
  function edit<K extends keyof PolicyFields>(key: K, value: PolicyFields[K]) {
    setDraft((previous) => {
      const baseline = previous?.base ?? initial;
      const next = { ...(previous?.fields ?? policyFields(baseline.policy)), [key]: value };
      return JSON.stringify(next) === JSON.stringify(policyFields(baseline.policy))
        ? null
        : { base: baseline, fields: next };
    });
    setInvalid(false);
  }
  const save = useMutation({
    mutationFn: (p: BookingPolicy) =>
      api().bookingPolicy.save({ generation: base.generation, policy: p }),
    onSuccess: (p) => {
      queries.setQueryData(["admin", "booking-policy"], p);
      setDraft(null);
      setSavedVersion(`${p.generation}:${p.policy.version}`);
      void queries.invalidateQueries({ queryKey: ["booking-policy"] });
    },
  });
  const reload = useMutation({
    mutationFn: () => api().bookingPolicy.admin(),
    onSuccess: (p) => {
      queries.setQueryData(["admin", "booking-policy"], p);
      setDraft((previous) => {
        if (!previous) return null;
        const old = policyFields(previous.base.policy);
        const remote = policyFields(p.policy);
        const local = previous.fields;
        const keepDeposit = local.kind !== old.kind || !sameDecimal(local.value, old.value);
        const merged = {
          enabled: local.enabled === old.enabled ? remote.enabled : local.enabled,
          kind: keepDeposit ? local.kind : remote.kind,
          trusted: local.trusted === old.trusted ? remote.trusted : local.trusted,
          value: keepDeposit ? local.value : remote.value,
          hold: local.hold === old.hold ? remote.hold : local.hold,
          window: local.window === old.window ? remote.window : local.window,
          late: sameDecimal(local.late, old.late) ? remote.late : local.late,
          noShow: sameDecimal(local.noShow, old.noShow) ? remote.noShow : local.noShow,
        };
        return JSON.stringify(merged) === JSON.stringify(remote)
          ? null
          : { base: p, fields: merged };
      });
      save.reset();
      setSavedVersion(undefined);
    },
  });
  return (
    <form
      className="max-w-2xl space-y-4 rounded-xl border border-line bg-surface p-5"
      aria-label={t("protection.title")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!online || !dirty || stale || save.isPending || reload.isPending) return;
        const parsed = bookingPolicyInputSchema.safeParse(input);
        setInvalid(!parsed.success);
        setSavedVersion(undefined);
        if (parsed.success && hold.trim() && window.trim()) save.mutate(parsed.data);
        else setInvalid(true);
      }}
    >
      <UnsavedGuard dirty={dirty} preserveOnSearchChange />
      <h2 className="text-heading">{t("protection.title")}</h2>
      <p className="text-sm text-muted">{t("protection.help")}</p>
      <fieldset className="min-w-0 space-y-4" disabled={save.isPending || reload.isPending}>
        <legend className="sr-only">{t("protection.title")}</legend>
        <label className="flex min-h-11 items-center gap-3">
          <input
            className="size-5 accent-accent"
            type="checkbox"
            checked={enabled}
            onChange={(e) => edit("enabled", e.target.checked)}
          />
          {t("protection.enabled")}
        </label>
        <SelectField
          label={t("protection.kind")}
          value={kind}
          options={[
            { value: "percent", label: t("protection.percent") },
            { value: "fixed", label: t("protection.fixed") },
          ]}
          onChange={(v) => edit("kind", v as typeof kind)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("protection.value")}
            inputMode="decimal"
            value={value}
            onChange={(e) => edit("value", e.target.value)}
          />
          <TextField
            label={t("protection.hold")}
            inputMode="numeric"
            value={hold}
            onChange={(e) => edit("hold", e.target.value)}
          />
          <TextField
            label={t("protection.window")}
            inputMode="numeric"
            value={window}
            onChange={(e) => edit("window", e.target.value)}
          />
          <TextField
            label={t("protection.late")}
            inputMode="decimal"
            value={late}
            onChange={(e) => edit("late", e.target.value)}
          />
          <TextField
            label={t("protection.noShow")}
            inputMode="decimal"
            value={noShow}
            onChange={(e) => edit("noShow", e.target.value)}
          />
        </div>
        <label className="flex min-h-11 items-center gap-3">
          <input
            className="size-5 accent-accent"
            type="checkbox"
            checked={trusted}
            onChange={(e) => edit("trusted", e.target.checked)}
          />
          {t("protection.trusted")}
        </label>
      </fieldset>
      {(invalid || save.isError || reload.isError) && <p role="alert">{t("protection.error")}</p>}
      {stale && <p role="status">{t("protection.policyChanged")}</p>}
      {savedVersion === `${initial.generation}:${initial.policy.version}` && !dirty && (
        <p role="status">{t("protection.saved")}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={!online || !dirty || stale || save.isPending || reload.isPending}
        >
          {t("protection.save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!online || save.isPending || reload.isPending}
          onClick={() => reload.mutate()}
        >
          {t("protection.reload")}
        </Button>
      </div>
    </form>
  );
}
