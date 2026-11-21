import { type Checkout, returnCheckoutPointsInputSchema, rewardChoiceSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { promotionTimingConditions } from "~/lib/promotion-timing";
import { invalidateCommerce } from "./invalidate";

export function RewardTender({
  checkout,
  mode,
}: {
  checkout: Pick<Checkout, "id" | "clientId" | "totalCents">;
  mode: CommerceMode;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [kind, setKind] = useState<"points" | "promotion">("promotion");
  const [points, setPoints] = useState("");
  const [code, setCode] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const statement = useQuery({
    queryKey: ["rewards", mode, checkout.clientId],
    queryFn: () => api().rewards.statement(mode, checkout.clientId ?? undefined),
    enabled: Boolean(checkout.clientId),
    refetchOnMount: "always",
  });
  const choice =
    kind === "points"
      ? { kind, points: /^\d+$/.test(points) ? Number(points) : 0 }
      : { kind, code: code.trim().toUpperCase() };
  const signature = JSON.stringify({
    id: checkout.id,
    clientId: checkout.clientId,
    total: checkout.totalCents,
    choice,
  });
  const preview = useMutation({
    mutationFn: async () => {
      const parsed = rewardChoiceSchema.parse(choice);
      return {
        quote: await api().rewards.quote(checkout.id, parsed, mode),
        choice: parsed,
        signature,
      };
    },
  });
  const quoted = preview.data?.signature === signature ? preview.data : null;
  const apply = useMutation({
    mutationFn: () => {
      if (!quoted) throw new Error("Review the current discount");
      return api().rewards.apply(
        checkout.id,
        {
          ...quoted.choice,
          expectedTotalCents: quoted.quote.currentTotalCents,
          expectedDiscountCents: quoted.quote.discountCents,
          idempotencyKey: key,
          ...(quoted.choice.kind === "promotion" && quoted.quote.promotionVersion
            ? { expectedPromotionVersion: quoted.quote.promotionVersion }
            : {}),
        },
        mode,
      );
    },
    onSuccess: () => {
      preview.reset();
      setKey(crypto.randomUUID());
      void invalidateCommerce(queries);
    },
  });
  function changed() {
    preview.reset();
    apply.reset();
    setKey(crypto.randomUUID());
  }
  const valid =
    rewardChoiceSchema.safeParse(choice).success &&
    (kind !== "points" ||
      Boolean(statement.data?.policy.enabled && Number(points) <= statement.data.availablePoints));
  return (
    <form
      aria-label={t("loyalty.title")}
      className="space-y-3 rounded-xl border border-line bg-sunken p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) preview.mutate();
      }}
    >
      <h3 className="font-semibold">{t("loyalty.title")}</h3>
      <p className="text-sm text-muted">{t("loyalty.rewardHelp")}</p>
      {statement.isPending ? (
        <Skeleton className="h-6" />
      ) : statement.isError ? (
        <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />
      ) : (
        statement.data && (
          <p>
            {t("loyalty.availableCount", {
              count: statement.data.availablePoints,
              points: new Intl.NumberFormat(locale).format(statement.data.availablePoints),
            })}
          </p>
        )
      )}
      {statement.data && !statement.data.policy.enabled && (
        <p className="text-sm text-muted">{t("loyalty.disabled")}</p>
      )}
      <SelectField
        label={t("loyalty.rewardType")}
        value={kind}
        options={[
          { value: "promotion", label: t("loyalty.promotionOption") },
          { value: "points", label: t("loyalty.pointsOption") },
        ]}
        onChange={(v) => {
          setKind(v as typeof kind);
          changed();
        }}
      />
      {kind === "points" ? (
        <TextField
          label={t("loyalty.pointsToUse")}
          inputMode="numeric"
          value={points}
          onChange={(e) => {
            setPoints(e.target.value);
            changed();
          }}
        />
      ) : (
        <TextField
          label={t("loyalty.code")}
          autoComplete="off"
          maxLength={40}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            changed();
          }}
        />
      )}
      <Button
        type="submit"
        variant="secondary"
        disabled={!online || !valid || preview.isPending || apply.isPending}
      >
        {t("loyalty.preview")}
      </Button>
      {quoted && (
        <div className="space-y-3 border-t border-line pt-3">
          <p role="status" className="font-semibold">
            {t("loyalty.quote", {
              amount: formatMoney(quoted.quote.discountCents, "EUR", locale),
              total: formatMoney(quoted.quote.newTotalCents, "EUR", locale),
            })}
          </p>
          {quoted.quote.appointmentTiming &&
            promotionTimingConditions(
              quoted.quote.appointmentTiming.timing,
              quoted.quote.appointmentTiming.timeZone,
              locale,
            ).map((text) => (
              <p key={text} className="text-sm text-muted">
                {text}
              </p>
            ))}
          <Button
            type="button"
            disabled={!online || apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t("loyalty.apply")}
          </Button>
        </div>
      )}
      {(preview.isError || apply.isError) && (
        <p role="alert">
          {t(
            (preview.error instanceof ApiError &&
              preview.error.code === "promotion_timing_mismatch") ||
              (apply.error instanceof ApiError && apply.error.code === "promotion_timing_mismatch")
              ? "timedPromotions.mismatch"
              : "loyalty.error",
          )}
        </p>
      )}
    </form>
  );
}

export function RewardReceipt({
  checkout,
  mode,
  canRefund,
}: {
  checkout: Checkout;
  mode: CommerceMode;
  canRefund: boolean;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [reason, setReason] = useState("");
  const reviewedReturn = returnCheckoutPointsInputSchema.safeParse({ reason });
  const returned = useMutation({
    mutationFn: (input: { reason: string }) =>
      api().rewards.returnPoints(checkout.id, input.reason, mode),
    onSuccess: () => {
      setReason("");
      void invalidateCommerce(queries);
    },
  });
  const reward = checkout.reward;
  if (!reward) return null;
  const canReturn =
    mode === "admin" &&
    canRefund &&
    (checkout.canReturnPoints ??
      (checkout.fulfilledAt &&
        reward.kind === "points" &&
        reward.state === "applied" &&
        reward.returnedPoints < reward.pointsUsed &&
        checkout.paidCents - checkout.refundedCents <= 0));
  return (
    <div className="space-y-2 rounded-xl border border-line bg-sunken p-4">
      <h3 className="font-semibold">
        {reward.kind === "points" ? t("loyalty.pointsOption") : reward.name}
      </h3>
      {reward.code && <p className="break-all font-medium">{reward.code}</p>}
      {reward.appointmentTiming &&
        promotionTimingConditions(
          reward.appointmentTiming.timing,
          reward.appointmentTiming.timeZone,
          locale,
        ).map((text) => (
          <p key={text} className="text-sm text-muted">
            {text}
          </p>
        ))}
      <p>{t("loyalty.applied", { amount: formatMoney(reward.discountCents, "EUR", locale) })}</p>
      {reward.pointsUsed > 0 && <p>{t("loyalty.used", { points: reward.pointsUsed })}</p>}
      {reward.returnedPoints > 0 && (
        <p>{t("loyalty.returned", { points: reward.returnedPoints })}</p>
      )}
      {canReturn && (
        <details>
          <summary className="cursor-pointer py-2 font-medium">{t("loyalty.returnPoints")}</summary>
          <p className="my-3 text-sm text-muted">{t("loyalty.returnHelp")}</p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (online && reviewedReturn.success && !returned.isPending)
                returned.mutate(reviewedReturn.data);
            }}
          >
            <TextField
              name="reason"
              label={t("loyalty.reason")}
              value={reason}
              maxLength={300}
              disabled={returned.isPending}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              type="submit"
              disabled={!online || !reviewedReturn.success || returned.isPending}
            >
              {t("loyalty.returnPoints")}
            </Button>
            {returned.isError && <p role="alert">{t("loyalty.error")}</p>}
          </form>
        </details>
      )}
    </div>
  );
}
