import { type BookingPolicy, bookingPolicyInputSchema } from "@sob/contracts";
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
    queryFn: () => api().bookingPolicy.admin(),
  });
  if (query.isPending) return <Skeleton className="h-48" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <PolicyEditor initial={query.data} />;
}
function PolicyEditor({ initial }: { initial: BookingPolicy }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [base, setBase] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [kind, setKind] = useState(initial.depositKind);
  const [trusted, setTrusted] = useState(initial.trustedExempt);
  const [value, setValue] = useState(centsInput(initial.depositValue));
  const [hold, setHold] = useState(String(initial.holdMinutes));
  const [window, setWindow] = useState(String(initial.cancellationWindowMinutes));
  const [late, setLate] = useState(centsInput(initial.lateCancellationBasisPoints));
  const [noShow, setNoShow] = useState(centsInput(initial.noShowBasisPoints));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const input = {
    enabled,
    depositKind: kind,
    depositValue: inputCents(value),
    holdMinutes: Number(hold),
    cancellationWindowMinutes: Number(window),
    lateCancellationBasisPoints: inputCents(late),
    noShowBasisPoints: inputCents(noShow),
    trustedExempt: trusted,
    version: base.version,
  };
  const dirty =
    JSON.stringify(input) !==
    JSON.stringify({
      enabled: base.enabled,
      depositKind: base.depositKind,
      depositValue: base.depositValue,
      holdMinutes: base.holdMinutes,
      cancellationWindowMinutes: base.cancellationWindowMinutes,
      lateCancellationBasisPoints: base.lateCancellationBasisPoints,
      noShowBasisPoints: base.noShowBasisPoints,
      trustedExempt: base.trustedExempt,
      version: base.version,
    });
  const reset = (p: BookingPolicy) => {
    setBase(p);
    setEnabled(p.enabled);
    setKind(p.depositKind);
    setTrusted(p.trustedExempt);
    setValue(centsInput(p.depositValue));
    setHold(String(p.holdMinutes));
    setWindow(String(p.cancellationWindowMinutes));
    setLate(centsInput(p.lateCancellationBasisPoints));
    setNoShow(centsInput(p.noShowBasisPoints));
    setInvalid(false);
  };
  const save = useMutation({
    mutationFn: (p: BookingPolicy) => api().bookingPolicy.save(p),
    onSuccess: (p) => {
      reset(p);
      setSaved(true);
      void queries.invalidateQueries({ queryKey: ["booking-policy"] });
      void queries.invalidateQueries({ queryKey: ["admin", "booking-policy"] });
    },
  });
  const reload = useMutation({
    mutationFn: () => api().bookingPolicy.admin(),
    onSuccess: (p) => {
      reset(p);
      save.reset();
      setSaved(false);
    },
  });
  return (
    <form
      className="max-w-2xl space-y-4 rounded-xl border border-line bg-surface p-5"
      aria-label={t("protection.title")}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = bookingPolicyInputSchema.safeParse(input);
        setInvalid(!parsed.success);
        setSaved(false);
        if (parsed.success && hold.trim() && window.trim()) save.mutate(parsed.data);
        else setInvalid(true);
      }}
    >
      <UnsavedGuard dirty={dirty} />
      <h2 className="text-heading">{t("protection.title")}</h2>
      <p className="text-sm text-muted">{t("protection.help")}</p>
      <label className="flex min-h-11 items-center gap-3">
        <input
          className="size-5 accent-accent"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
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
        onChange={(v) => setKind(v as typeof kind)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t("protection.value")}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <TextField
          label={t("protection.hold")}
          inputMode="numeric"
          value={hold}
          onChange={(e) => setHold(e.target.value)}
        />
        <TextField
          label={t("protection.window")}
          inputMode="numeric"
          value={window}
          onChange={(e) => setWindow(e.target.value)}
        />
        <TextField
          label={t("protection.late")}
          inputMode="decimal"
          value={late}
          onChange={(e) => setLate(e.target.value)}
        />
        <TextField
          label={t("protection.noShow")}
          inputMode="decimal"
          value={noShow}
          onChange={(e) => setNoShow(e.target.value)}
        />
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input
          className="size-5 accent-accent"
          type="checkbox"
          checked={trusted}
          onChange={(e) => setTrusted(e.target.checked)}
        />
        {t("protection.trusted")}
      </label>
      {(invalid || save.isError || reload.isError) && <p role="alert">{t("protection.error")}</p>}
      {saved && !dirty && <p role="status">{t("protection.saved")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!online || !dirty || save.isPending || reload.isPending}>
          {t("protection.save")}
        </Button>
        <Button
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
