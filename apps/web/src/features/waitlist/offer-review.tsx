import {
  type Appointment,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
  type WaitlistEntry,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { invalidateCommerce } from "~/features/admin/commerce/invalidate";
import { useNow } from "~/features/admin/use-now";
import { PriceTermsConsent, usePriceTerms } from "~/features/booking/price-terms";
import { BookingPolicyConsent } from "~/features/booking/protection";
import { priceLabel, totalPriceLabel } from "~/features/booking/service-price";
import { BookingForms, useBookingForms } from "~/features/intake/booking-forms";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";
export function WaitlistOfferReview({
  entry,
  mode,
  role,
  accessPreset,
  onBooked,
}: {
  entry: WaitlistEntry;
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  onBooked: (appointment: Appointment) => void;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const now = useNow(1000);
  const queries = useQueryClient();
  const toast = useToast();
  const [consent, setConsent] = useState<number | null>(null);
  const [waiver, setWaiver] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const offer = entry.offer;
  const priceTerms = usePriceTerms(offer?.services ?? []);
  const intake = useBookingForms({
    serviceIds: entry.serviceIds,
    enabled: Boolean(offer) && entry.canManage,
    team: mode === "admin",
    subjectKey: entry.clientId,
    clientId: mode === "admin" ? entry.clientId : undefined,
  });
  const accept = useMutation({
    mutationFn: () => {
      if (!offer) throw new Error("Missing waitlist offer");
      if (!intake.ready) throw new Error("Complete the current forms");
      return api().waitlist.accept(mode, entry.id, {
        ...intake.payload,
        ...(mode === "client" && priceTerms.required ? { priceTermsAccepted: true } : {}),
        ...(mode === "client" &&
        offer.services.some((s) => s.priceType === "variable") &&
        offer.policy.enabled
          ? { protectionAcceptedDepositCents: offer.policy.depositValue }
          : {}),
        version: entry.version,
        offerId: offer.id,
        expectedTotalCents: offer.priceCents,
        idempotencyKey: key,
        ...(mode === "client" && consent
          ? { protectionAcceptedVersion: consent, protectionAcceptedTotalCents: offer.priceCents }
          : {}),
        ...(mode === "admin" && waiver.trim() ? { protectionWaiverReason: waiver.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      toast.success(t("waitlist.accepted"));
      void queries.invalidateQueries({ queryKey: ["waitlist"] });
      void invalidateCommerce(queries);
      onBooked(result.appointment);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "intake_required") void intake.refresh();
    },
  });
  if (!offer) return null;
  const variablePrice = offer.services.some((s) => s.priceType === "variable");
  const expired = Date.parse(offer.expiresAt) <= now.getTime();
  const allowed =
    entry.canManage &&
    (mode !== "client" || priceTerms.accepted) &&
    (!offer.policy.enabled ||
      (mode === "client"
        ? consent === offer.policy.version &&
          (!variablePrice || offer.policy.depositKind === "fixed")
        : permissionsFor(role, accessPreset).refunds && waiver.trim().length >= 8));
  return (
    <div className="min-w-0 space-y-4">
      <BookingForms state={intake} />
      {mode === "client" && <PriceTermsConsent state={priceTerms} disabled={accept.isPending} />}
      <p className="text-heading">
        {formatDateLong(localDateOf(offer.startsAt, entry.timezone), locale)} ·{" "}
        {formatTime(offer.startsAt, entry.timezone, locale)}
      </p>
      <p className="text-sm text-muted">
        {t("waitlist.professional", { name: offer.staffName ?? t("account.staffFallback") })}
      </p>
      <ul className="space-y-2">
        {offer.services.map((s) => (
          <li key={s.id} className="flex min-w-0 items-start justify-between gap-3">
            <span className="min-w-0 break-words">{s.name}</span>
            <div className="shrink-0 text-right">
              <p>{priceLabel(t, locale, s, true)}</p>
              {s.peakSurchargeCents && (
                <p className="text-sm text-muted">
                  {t("bookingPeak.surcharge", {
                    amount: formatMoney(s.peakSurchargeCents, s.currency, locale),
                  })}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {offer.services
        .filter((s) => s.clientInstructions)
        .map((s) => (
          <p key={s.id} className="whitespace-pre-wrap text-sm text-muted">
            {s.name}: {s.clientInstructions}
          </p>
        ))}
      <p className="font-semibold">
        {t("waitlist.price", {
          price: totalPriceLabel(t, locale, offer.services, offer.priceCents, offer.currency, true),
        })}
      </p>
      <p className="text-sm text-muted">
        {t("waitlist.expires", {
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: entry.timezone,
          }).format(new Date(offer.expiresAt)),
        })}
      </p>
      {mode === "client" ? (
        <BookingPolicyConsent
          policy={offer.policy}
          variablePrice={variablePrice}
          totalCents={offer.priceCents}
          acceptedVersion={consent}
          onAccept={setConsent}
        />
      ) : offer.policy.enabled ? (
        <div className="space-y-3">
          <p>{t("waitlist.askCustomer")}</p>
          {permissionsFor(role, accessPreset).refunds && (
            <TextField
              label={t("protection.waiver")}
              maxLength={300}
              value={waiver}
              onChange={(e) => setWaiver(e.target.value)}
            />
          )}
        </div>
      ) : null}
      {expired && (
        <p role="status" className="text-warning-fg">
          {t("waitlist.expired")}
        </p>
      )}
      {accept.isError && (
        <>
          <ErrorState error={accept.error} />
          <p className="text-sm">{t("waitlist.changed")}</p>
        </>
      )}
      <Button
        onClick={() => accept.mutate()}
        loading={accept.isPending}
        disabled={!online || expired || !allowed || !intake.ready}
        className="max-w-full whitespace-normal!"
      >
        {t("waitlist.accept")}
      </Button>
    </div>
  );
}
