import { type BenefitPlan, MEMBERSHIP_RECURRING_CONSENT_VERSION } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { invalidateCommerce } from "./invalidate";
export function BenefitPlanPurchase({
  plan,
  mode,
  disabled,
  automaticAvailable,
  onCreated,
}: {
  plan: BenefitPlan;
  mode: CommerceMode;
  disabled: boolean;
  automaticAvailable: boolean;
  onCreated: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [buyer, setBuyer] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [renewalMode, setRenewalMode] = useState<"manual" | "automatic">("manual");
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const clients = useQuery({
    ...clientsQuery({ search, pageSize: 20, sort: "name", order: "asc" }),
    enabled: mode === "admin" && open && search.trim().length > 0,
  });
  const services = useQuery({
    queryKey: ["passes", "service-names"],
    queryFn: () => api().services(),
  });
  const names = plan.serviceIds.flatMap(
    (id) =>
      services.data?.services
        .filter((s) => s.id === id && s.currency === "EUR")
        .map((s) => s.name) ?? [],
  );
  const servicesReady = services.isSuccess && names.length === plan.serviceIds.length;
  const canEnroll = mode === "client" && plan.kind === "membership" && automaticAvailable;
  const automatic = renewalMode === "automatic";
  const changed = automatic && acceptedVersion !== null && acceptedVersion !== plan.version;
  const consentReady = !automatic || (canEnroll && acceptedVersion === plan.version);
  const buy = useMutation({
    mutationFn: () => {
      if (!servicesReady || !consentReady) throw new Error("Review plan terms");
      return api().passes.purchase(
        {
          planId: plan.id,
          planVersion: plan.version,
          ...(mode === "admin" ? { clientId: buyer } : {}),
          renewalMode,
          acceptRecurring: automatic,
          ...(automatic ? { consentVersion: MEMBERSHIP_RECURRING_CONSENT_VERSION } : {}),
          idempotencyKey: key,
        },
        mode,
      );
    },
    onSuccess: (result) => {
      void invalidateCommerce(queries);
      onCreated(result.pass.id);
    },
  });
  const change = () => {
    setKey(crypto.randomUUID());
    buy.reset();
  };
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h4 className="break-words font-semibold">{plan.name}</h4>
      <p>
        {formatMoney(plan.priceCents, "EUR", locale)} ·{" "}
        {t(plan.kind === "package" ? "passes.package" : "passes.membership")}
      </p>
      {plan.description && <p className="text-sm text-muted">{plan.description}</p>}
      <p className="text-sm">
        {t("passes.uses")}: {plan.includedUses}
      </p>
      {plan.discountBasisPoints > 0 && (
        <p>{t("passes.discounts", { discount: plan.discountBasisPoints / 100 })}</p>
      )}
      {plan.periodMonths && (
        <p className="text-sm">
          {t("passes.months")}: {plan.periodMonths}
        </p>
      )}
      {plan.validityDays && (
        <p className="text-sm">
          {t("passes.days")}: {plan.validityDays}
        </p>
      )}
      <p className="text-sm font-medium">{t("passes.services")}</p>
      {services.isPending ? (
        <Skeleton className="h-12" />
      ) : services.isError ? (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      ) : !servicesReady ? (
        <p role="alert" className="text-sm">
          {t("passes.servicesChanged")}
        </p>
      ) : (
        <ul className="list-disc pl-5 text-sm text-muted">
          {names.map((name, index) => (
            <li key={plan.serviceIds[index]}>{name}</li>
          ))}
        </ul>
      )}
      <Button variant="secondary" disabled={disabled || !online} onClick={() => setOpen(!open)}>
        {t("passes.buy")}
      </Button>
      {open && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            buy.mutate();
          }}
        >
          {mode === "admin" && (
            <>
              <TextField
                label={t("passes.searchBuyer")}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setBuyer("");
                  change();
                }}
              />
              {clients.isError ? (
                <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
              ) : (
                <SelectField
                  label={t("passes.selectBuyer")}
                  value={buyer}
                  options={[
                    { value: "", label: t("passes.selectBuyer") },
                    ...(clients.data?.clients ?? []).map((client) => ({
                      value: client.id,
                      label: client.name,
                    })),
                  ]}
                  onChange={(value) => {
                    setBuyer(value);
                    change();
                  }}
                />
              )}
            </>
          )}
          {plan.kind === "membership" && (
            <>
              {(canEnroll || automatic) && (
                <SelectField
                  label={t("passes.renewalPayment")}
                  value={renewalMode}
                  options={[
                    { value: "manual", label: t("passes.payManually") },
                    { value: "automatic", label: t("passes.payAutomatically") },
                  ]}
                  onChange={(value) => {
                    setRenewalMode(value as typeof renewalMode);
                    setAcceptedVersion(null);
                    change();
                  }}
                />
              )}
              <p className="text-sm text-muted">
                {t(automatic ? "passes.recurringHelp" : "passes.manualHelp")}
              </p>
              {automatic && (
                <>
                  <label className="flex min-h-11 items-start gap-3 rounded-md border border-line p-3">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={acceptedVersion === plan.version}
                      onChange={(event) => {
                        setAcceptedVersion(event.target.checked ? plan.version : null);
                        change();
                      }}
                    />
                    <span>
                      {t("passes.recurringAgreement", {
                        amount: formatMoney(plan.priceCents, "EUR", locale),
                        count: plan.periodMonths ?? 1,
                      })}
                    </span>
                  </label>
                  {changed && <p role="alert">{t("passes.termsChanged")}</p>}
                  {!canEnroll && <p role="alert">{t("passes.recurringUnavailable")}</p>}
                </>
              )}
            </>
          )}
          {buy.isError && <p role="alert">{t("passes.error")}</p>}
          <Button
            type="submit"
            disabled={
              !online ||
              buy.isPending ||
              !servicesReady ||
              !consentReady ||
              (mode === "admin" && !buyer)
            }
          >
            {t("passes.create")}
          </Button>
        </form>
      )}
    </div>
  );
}
