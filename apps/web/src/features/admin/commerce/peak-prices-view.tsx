import { type PeakPricePolicy, type PeakPriceRule, peakPricePolicySchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { promotionWeekday } from "~/lib/promotion-timing";
import { UnsavedGuard } from "../unsaved-guard";
import { GiftServicePicker } from "./gift-service-picker";

const policyKey = ["peak-price-policy"];
const weekdays = [1, 2, 3, 4, 5, 6, 7];
type DraftRule = PeakPriceRule & { key: string };

function clock(minute: number) {
  if (!Number.isFinite(minute)) return "";
  return [Math.floor(minute / 60) % 24, minute % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function minutes(value: string) {
  return value === "" ? NaN : Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

const draftRules = (policy: PeakPricePolicy): DraftRule[] =>
  policy.rules.map((rule, index) => ({ ...rule, key: `${policy.version}-${index}` }));

export function PeakPricesView() {
  const { t, timeZone } = useI18n();
  const policy = useQuery({
    queryKey: policyKey,
    queryFn: () => api().admin.peakPrices.get(),
  });
  return (
    <section aria-label={t("peakPrices.title")} className="space-y-4">
      <h3 className="text-heading">{t("peakPrices.title")}</h3>
      <p>{t("peakPrices.help")}</p>
      <p className="text-sm text-muted">{t("peakPrices.timezone", { zone: timeZone })}</p>
      {policy.isPending ? (
        <Skeleton className="h-36" />
      ) : policy.isError ? (
        <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
      ) : (
        <PeakPricesEditor initial={policy.data} />
      )}
    </section>
  );
}

function PeakPricesEditor({ initial }: { initial: PeakPricePolicy }) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(() => draftRules(initial));
  const [invalid, setInvalid] = useState(false);
  const catalog = useQuery({
    queryKey: ["peak-price-services"],
    queryFn: ({ signal }) => api().admin.services.list(signal),
    enabled: draft.length > 0,
  });
  const services = catalog.data?.services.filter((service) => service.active) ?? [];
  const rules = draft.map(({ key: _, ...rule }) => rule);
  const dirty = JSON.stringify(rules) !== JSON.stringify(baseline.rules);
  const save = useMutation({
    mutationFn: (policy: PeakPricePolicy) => api().admin.peakPrices.save(policy),
    onSuccess: (policy) => {
      setBaseline(policy);
      setDraft(draftRules(policy));
      queries.setQueryData(policyKey, policy);
    },
  });
  const reload = useMutation({
    mutationFn: () => api().admin.peakPrices.get(),
    onSuccess: (policy) => {
      setBaseline(policy);
      setDraft(draftRules(policy));
      setInvalid(false);
      save.reset();
      queries.setQueryData(policyKey, policy);
    },
  });
  const stale =
    save.error instanceof ApiError &&
    (save.error.code === "version_conflict" || save.error.code === "sync_generation_changed");
  const setRule = (key: string, changes: Partial<PeakPriceRule>) => {
    setDraft((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...changes } : rule)),
    );
  };
  const append = (rule: PeakPriceRule) => {
    setDraft((current) => [...current, { ...rule, key: crypto.randomUUID() }]);
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!online || !dirty || save.isPending || stale) return;
        const policy = peakPricePolicySchema.safeParse({ ...baseline, rules });
        setInvalid(!policy.success);
        if (policy.success) save.mutate(policy.data);
      }}
    >
      <UnsavedGuard dirty={dirty} />
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
        {draft.length === 0 && <p className="text-sm text-muted">{t("peakPrices.empty")}</p>}
        {draft.map(({ key, ...rule }, index) => (
          <fieldset key={key} className="min-w-0 space-y-4 rounded-xl border border-line p-4">
            <legend className="px-2 font-medium">
              {t("peakPrices.rule", { number: index + 1 })}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SelectField
                label={t("peakPrices.weekday")}
                value={String(rule.weekday)}
                options={weekdays.map((day) => ({
                  value: String(day),
                  label: promotionWeekday(day, locale),
                }))}
                onChange={(value) => setRule(key, { weekday: Number(value) })}
              />
              <TextField
                label={t("peakPrices.start")}
                type="time"
                required
                value={clock(rule.startMinute)}
                onChange={(event) => setRule(key, { startMinute: minutes(event.target.value) })}
              />
              <TextField
                label={t("peakPrices.end")}
                type="time"
                required
                value={clock(rule.endMinute)}
                onChange={(event) => {
                  const endMinute = minutes(event.target.value);
                  setRule(key, { endMinute: endMinute === 0 ? 1440 : endMinute });
                }}
              />
              <TextField
                label={t("peakPrices.increase")}
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                required
                value={
                  Number.isFinite(rule.increaseBasisPoints) ? rule.increaseBasisPoints / 100 : ""
                }
                onChange={(event) =>
                  setRule(key, {
                    increaseBasisPoints: Math.round(event.target.valueAsNumber * 100),
                  })
                }
              />
            </div>
            {catalog.isSuccess && (
              <GiftServicePicker
                selected={rule.serviceIds.map((id) => ({
                  id,
                  name: catalog.data.services.find((service) => service.id === id)?.name ?? id,
                }))}
                reviewedCatalogue={services}
                maximum={200}
                disabled={save.isPending}
                onChange={(selected) => setRule(key, { serviceIds: selected.map(({ id }) => id) })}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={draft.length >= 100}
                onClick={() => append({ ...rule, weekday: (rule.weekday % 7) + 1 })}
              >
                {t("peakPrices.copy")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDraft((current) => current.filter((row) => row.key !== key))}
              >
                {t("peakPrices.remove")}
              </Button>
            </div>
          </fieldset>
        ))}
        {draft.length > 0 && catalog.isError && (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={draft.length >= 100}
            onClick={() =>
              append({
                weekday: 1,
                startMinute: 540,
                endMinute: 600,
                increaseBasisPoints: 1000,
                serviceIds: [],
              })
            }
          >
            {t("peakPrices.add")}
          </Button>
          <Button
            type="submit"
            disabled={!online || !dirty || stale || (draft.length > 0 && !catalog.isSuccess)}
          >
            {t("peakPrices.save")}
          </Button>
        </div>
      </fieldset>
      {invalid && <p role="alert">{t("peakPrices.invalid")}</p>}
      {save.isSuccess && !dirty && <p role="status">{t("peakPrices.saved")}</p>}
      {save.isError && <ErrorState error={save.error} />}
      {reload.isError && <ErrorState error={reload.error} />}
      {stale && (
        <Button
          type="button"
          variant="secondary"
          disabled={!online || reload.isPending}
          onClick={() => reload.mutate()}
        >
          {t("peakPrices.reload")}
        </Button>
      )}
    </form>
  );
}
