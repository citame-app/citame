import { type WaitlistPolicy, waitlistPolicySchema } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
export function WaitlistPolicyForm({ initial }: { initial: WaitlistPolicy }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [base, setBase] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [minutes, setMinutes] = useState(String(initial.offerMinutes));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const reset = (p: WaitlistPolicy) => {
    setBase(p);
    setEnabled(p.enabled);
    setMinutes(String(p.offerMinutes));
    setInvalid(false);
  };
  const save = useMutation({
    mutationFn: (input: WaitlistPolicy) => api().waitlist.savePolicy(input),
    onSuccess: (p) => {
      reset(p);
      setSaved(true);
      void queries.invalidateQueries({ queryKey: ["waitlist"] });
    },
  });
  const reload = useMutation({
    mutationFn: async () => (await api().waitlist.list("admin")).policy,
    onSuccess: (p) => {
      reset(p);
      save.reset();
      setSaved(false);
    },
  });
  return (
    <form
      aria-label={t("waitlist.policy")}
      className="space-y-4 rounded-xl border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        const input = waitlistPolicySchema.safeParse({
          enabled,
          offerMinutes: /^\d+$/.test(minutes) ? Number(minutes) : null,
          version: base.version,
        });
        setInvalid(!input.success);
        if (input.success) save.mutate(input.data);
      }}
    >
      <UnsavedGuard dirty={enabled !== base.enabled || minutes !== String(base.offerMinutes)} />
      <h2 className="text-heading">{t("waitlist.policy")}</h2>
      <p className="text-sm text-muted">{t("waitlist.policyHelp")}</p>
      <label className="flex min-h-11 items-start gap-3">
        <input
          disabled={save.isPending || reload.isPending}
          type="checkbox"
          className="mt-1 size-5 shrink-0 accent-accent"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>{t("waitlist.enabled")}</span>
      </label>
      <TextField
        disabled={save.isPending || reload.isPending}
        label={t("waitlist.minutes")}
        type="number"
        min={5}
        max={120}
        step={1}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
      />
      {invalid && (
        <p role="alert" className="text-danger-fg">
          {t("waitlist.policyInvalid")}
        </p>
      )}
      {save.isError && <ErrorState error={save.error} />}{" "}
      {reload.isError && <ErrorState error={reload.error} />}
      {saved && (
        <p role="status" className="text-success-fg">
          {t("waitlist.policySaved")}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={save.isPending} disabled={!online || reload.isPending}>
          {t("waitlist.policySave")}
        </Button>
        <Button
          variant="secondary"
          loading={reload.isPending}
          disabled={!online || save.isPending}
          className="whitespace-normal!"
          onClick={() => reload.mutate()}
        >
          {t("waitlist.reload")}
        </Button>
      </div>
    </form>
  );
}
