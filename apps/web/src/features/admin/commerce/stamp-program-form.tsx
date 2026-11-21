import {
  type StampProgramInput,
  type StampProgramTerms,
  stampProgramTermsSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { stampCardsQueryKey, stampProgramQueryKey } from "~/lib/api/reward-endpoints";
import { UnsavedGuard } from "../unsaved-guard";
import { useDebounced } from "../use-debounced";
import { centsInput, inputCents } from "./money";

const query = {
  queryKey: stampProgramQueryKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => api().rewards.stampProgram(signal),
};
const serviceOptions = {
  queryKey: ["rewards", "stamp-services"],
  queryFn: () => api().admin.services.list(),
};

type Programme = Awaited<ReturnType<ReturnType<typeof api>["rewards"]["stampProgram"]>>;
const editable = (terms: StampProgramTerms) => ({
  terms,
  minimum: centsInput(terms.minimumSpendCents),
  discount:
    terms.reward.discountBasisPoints === null ? "" : centsInput(terms.reward.discountBasisPoints),
});

export function StampProgramForm() {
  const base = useQuery(query);
  if (base.isPending) return <Skeleton className="h-40" />;
  if (!base.data) return <ErrorState error={base.error} onRetry={() => void base.refetch()} />;
  return <ProgrammeEditor current={base.data} />;
}

function ProgrammeEditor({ current }: { current: Programme }) {
  const { t } = useI18n();
  const online = useOnline();
  const heading = useId();
  const client = useQueryClient();
  const [draft, setDraft] = useState<{ base: Programme; form: ReturnType<typeof editable> }>();
  const [review, setReview] = useState<StampProgramInput>();
  const [existingCards, setExistingCards] = useState<StampProgramInput["existingCards"]>("keep");
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState<number>();
  const [serviceSearch, setServiceSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const productName = useDebounced(productSearch.trim());
  const base = draft?.base ?? current;
  const form = draft?.form ?? editable(current.program);
  const terms = form.terms;
  const sameGeneration = base.generation === current.generation;
  const possibleReplay =
    review &&
    current.version === review.version + 1 &&
    JSON.stringify(current.program) === JSON.stringify(review.program);
  const stale = !sameGeneration || (base.version !== current.version && !possibleReplay);
  const services = useQuery(serviceOptions);
  const products = useQuery({
    queryKey: ["rewards", "stamp-products", productName],
    queryFn: () => api().inventory.list({ pageSize: 100, search: productName }),
    enabled: terms.reward.kind === "product",
  });

  function edit(next: Partial<typeof form>) {
    setDraft({ base, form: { ...form, ...next } });
    setInvalid(false);
    setSaved(undefined);
  }
  const setTerms = (change: Partial<StampProgramTerms>) => edit({ terms: { ...terms, ...change } });
  const setReward = (change: Partial<StampProgramTerms["reward"]>) =>
    setTerms({ reward: { ...terms.reward, ...change } });

  const save = useMutation({
    mutationFn: (packet: StampProgramInput) => api().rewards.saveStampProgram(packet),
    onSuccess: (result) => {
      const latest = client.getQueryData<Programme>(stampProgramQueryKey);
      if (latest && latest.generation !== result.generation) return;
      client.setQueryData(
        stampProgramQueryKey,
        latest && latest.version > result.version ? latest : result,
      );
      setDraft(undefined);
      setReview(undefined);
      setExistingCards("keep");
      setSaved(result.version);
      void client.invalidateQueries({ queryKey: stampCardsQueryKey });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status < 500 && error.status !== 408)
        setReview(undefined);
      if (error instanceof ApiError && error.status === 409)
        void client.invalidateQueries({ queryKey: stampProgramQueryKey });
    },
  });
  const reload = useMutation({
    mutationFn: () => client.fetchQuery({ ...query, staleTime: 0 }),
    onSuccess: () => {
      setDraft(undefined);
      setReview(undefined);
      setInvalid(false);
      setExistingCards("keep");
      setSaved(undefined);
      save.reset();
    },
  });
  const busy = save.isPending || reload.isPending;
  const targetItems =
    terms.reward.kind === "service"
      ? (services.data?.services ?? []).filter((item) => item.active)
      : terms.reward.kind === "product"
        ? (products.data?.products ?? []).filter((item) => item.active)
        : [];
  const targetOptions = targetItems.map(({ id, name }) => ({ value: id, label: name }));
  if (terms.reward.targetId && !targetOptions.some(({ value }) => value === terms.reward.targetId))
    targetOptions.unshift({ value: terms.reward.targetId, label: t("stamps.currentTarget") });
  const filteredServices = (services.data?.services ?? []).filter(
    (item) =>
      item.active &&
      (terms.qualifyingServiceIds.includes(item.id) ||
        item.name.toLocaleLowerCase().includes(serviceSearch.trim().toLocaleLowerCase())),
  );
  const nullableInteger = (value: string) => (value === "" ? null : Number(value));

  return (
    <form
      aria-labelledby={heading}
      className="space-y-5 rounded-xl border border-line bg-surface p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!online || busy || stale) return;
        if (review) {
          save.mutate(review);
          return;
        }
        const parsed = stampProgramTermsSchema.safeParse({
          ...terms,
          minimumSpendCents: inputCents(form.minimum),
          reward: {
            ...terms.reward,
            discountBasisPoints: form.discount.trim() ? inputCents(form.discount) : null,
          },
        });
        setInvalid(!parsed.success);
        if (parsed.success)
          setReview({
            generation: base.generation,
            version: base.version,
            program: parsed.data,
            existingCards,
          });
      }}
    >
      <UnsavedGuard
        dirty={draft !== undefined || review !== undefined || existingCards !== "keep"}
      />
      <h2 id={heading} className="text-heading">
        {t("stamps.program")}
      </h2>
      <fieldset disabled={busy || Boolean(review)} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">{t("stamps.title")}</legend>
        <label className="flex min-h-11 items-center gap-3 sm:col-span-2">
          <input
            type="checkbox"
            name="enabled"
            checked={terms.enabled}
            onChange={(e) => setTerms({ enabled: e.target.checked })}
          />
          {t("stamps.enabled")}
        </label>
        <TextField
          name="name"
          label={t("stamps.name")}
          value={terms.name}
          maxLength={80}
          required
          onChange={(e) => setTerms({ name: e.target.value })}
        />
        <SelectField
          name="appearance"
          label={t("stamps.appearance")}
          value={terms.appearance}
          options={(["neutral", "rose", "mint"] as const).map((value) => ({
            value,
            label: t(`stamps.${value}`),
          }))}
          onChange={(value) => setTerms({ appearance: value as StampProgramTerms["appearance"] })}
        />
      </fieldset>
      <fieldset
        disabled={busy || Boolean(review)}
        className="grid gap-4 border-t border-line pt-3 sm:grid-cols-2"
      >
        <legend className="pr-2 font-semibold">{t("stamps.earn")}</legend>
        <TextField
          name="goal"
          label={t("stamps.goal")}
          type="number"
          min={1}
          max={15}
          required
          value={terms.goal || ""}
          onChange={(e) => setTerms({ goal: Number(e.target.value) })}
        />
        <TextField
          name="welcomeStamps"
          label={t("stamps.welcome")}
          type="number"
          min={0}
          max={Math.max(0, terms.goal - 1)}
          required
          value={terms.welcomeStamps}
          onChange={(e) => setTerms({ welcomeStamps: Number(e.target.value) })}
        />
        <TextField
          name="minimumSpend"
          label={t("stamps.minimum")}
          inputMode="decimal"
          required
          value={form.minimum}
          onChange={(e) => edit({ minimum: e.target.value })}
        />
        <SelectField
          name="awardOn"
          label={t("stamps.earnOn")}
          value={terms.awardOn}
          options={[
            { value: "checkout", label: t("stamps.checkout") },
            { value: "appointment", label: t("stamps.visit") },
          ]}
          onChange={(value) => setTerms({ awardOn: value as StampProgramTerms["awardOn"] })}
        />
        <fieldset className="min-w-0 space-y-2 sm:col-span-2">
          <legend className="font-medium">{t("stamps.services")}</legend>
          <p className="text-sm text-muted">{t("stamps.serviceHelp")}</p>
          <TextField
            name="serviceSearch"
            type="search"
            label={t("stamps.services")}
            value={serviceSearch}
            onChange={(e) => setServiceSearch(e.target.value)}
          />
          {terms.qualifyingServiceIds.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setTerms({ qualifyingServiceIds: [] })}
            >
              {t("stamps.clearServices")}
            </Button>
          )}
          {services.isError && (
            <ErrorState error={services.error} onRetry={() => void services.refetch()} />
          )}
          <div className="grid max-h-44 gap-1 overflow-auto rounded-md border border-line p-2 sm:grid-cols-2">
            {filteredServices.map((item) => (
              <label key={item.id} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="qualifyingServiceIds"
                  value={item.id}
                  checked={terms.qualifyingServiceIds.includes(item.id)}
                  onChange={(event) =>
                    setTerms({
                      qualifyingServiceIds: event.target.checked
                        ? [...terms.qualifyingServiceIds, item.id]
                        : terms.qualifyingServiceIds.filter((id) => id !== item.id),
                    })
                  }
                />
                {item.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-11 items-center gap-3 sm:col-span-2">
          <input
            type="checkbox"
            name="automaticIssue"
            checked={terms.automaticIssue}
            onChange={(e) => setTerms({ automaticIssue: e.target.checked })}
          />
          {t("stamps.auto")}
        </label>
        <TextField
          name="stampExpiryDays"
          label={t("stamps.expiry")}
          type="number"
          min={1}
          max={3650}
          hint={t("stamps.expiryHelp")}
          value={terms.stampExpiryDays ?? ""}
          onChange={(e) => setTerms({ stampExpiryDays: nullableInteger(e.target.value) })}
        />
        <SelectField
          name="expiryFrom"
          label={t("stamps.expiryFrom")}
          value={terms.expiryFrom}
          options={[
            { value: "issue", label: t("stamps.fromIssue") },
            { value: "activity", label: t("stamps.fromActivity") },
          ]}
          onChange={(value) => setTerms({ expiryFrom: value as StampProgramTerms["expiryFrom"] })}
        />
      </fieldset>
      <fieldset
        disabled={busy || Boolean(review)}
        className="grid gap-4 border-t border-line pt-3 sm:grid-cols-2"
      >
        <legend className="pr-2 font-semibold">{t("stamps.reward")}</legend>
        <TextField
          name="rewardName"
          label={t("stamps.rewardName")}
          value={terms.reward.name}
          maxLength={120}
          required
          onChange={(e) => setReward({ name: e.target.value })}
        />
        <SelectField
          name="rewardKind"
          label={t("stamps.rewardType")}
          value={terms.reward.kind}
          options={(["service", "product", "other"] as const).map((value) => ({
            value,
            label: t(`stamps.${value}`),
          }))}
          onChange={(value) =>
            setReward({ kind: value as StampProgramTerms["reward"]["kind"], targetId: null })
          }
        />
        {terms.reward.kind === "product" && (
          <TextField
            name="productSearch"
            type="search"
            label={t("stamps.productSearch")}
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
          />
        )}
        {terms.reward.kind !== "other" && (
          <SelectField
            name="rewardTarget"
            label={t("stamps.target")}
            value={terms.reward.targetId ?? ""}
            options={[{ value: "", label: t("stamps.noTarget") }, ...targetOptions]}
            onChange={(value) => setReward({ targetId: value || null })}
          />
        )}
        <TextField
          name="discount"
          label={t("stamps.discount")}
          inputMode="decimal"
          value={form.discount}
          onChange={(e) => edit({ discount: e.target.value })}
        />
        <TextField
          name="rewardExpiryDays"
          label={t("stamps.rewardExpiry")}
          type="number"
          min={1}
          max={3650}
          hint={t("stamps.expiryHelp")}
          value={terms.rewardExpiryDays ?? ""}
          onChange={(e) => setTerms({ rewardExpiryDays: nullableInteger(e.target.value) })}
        />
        <label className="grid gap-1 text-sm sm:col-span-2">
          {t("stamps.terms")}
          <textarea
            name="terms"
            className="min-h-24 rounded-md border border-line bg-surface p-3"
            maxLength={2000}
            value={terms.terms}
            onChange={(e) => setTerms({ terms: e.target.value })}
          />
        </label>
        <SelectField
          name="existingCards"
          label={t("stamps.previous")}
          value={existingCards}
          options={[
            { value: "keep", label: t("stamps.keep") },
            { value: "void", label: t("stamps.invalidate") },
          ]}
          onChange={(value) => setExistingCards(value as StampProgramInput["existingCards"])}
        />
      </fieldset>
      {review?.existingCards === "void" && <p role="status">{t("stamps.invalidateWarning")}</p>}
      {stale && <p role="status">{t("stamps.stale")}</p>}
      {saved === current.version && !draft && <p role="status">{t("stamps.saved")}</p>}
      {(invalid || (save.isError && !review) || reload.isError) && (
        <p role="alert">{t("stamps.invalid")}</p>
      )}
      {save.isError && review && <p role="alert">{t("stamps.waiting")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!online || busy || stale}>
          {t(review ? (save.isError ? "stamps.retry" : "stamps.save") : "stamps.review")}
        </Button>
        {review && !save.isError && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => setReview(undefined)}
          >
            {t("admin.cancel")}
          </Button>
        )}
        {(stale || save.isError) && (
          <Button
            type="button"
            variant="secondary"
            disabled={!online || busy}
            onClick={() => reload.mutate()}
          >
            {t("stamps.reload")}
          </Button>
        )}
      </div>
    </form>
  );
}
