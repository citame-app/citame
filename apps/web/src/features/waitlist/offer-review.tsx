import {
  type Appointment,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
  type WaitlistAccept,
  type WaitlistEntry,
} from "@sob/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { invalidateCommerce } from "~/features/admin/commerce/invalidate";
import { usePolicySubmission } from "~/features/admin/policy-submission";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
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

function blocksBookingVerification(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404, 429].includes(error.status);
}

export function WaitlistOfferReview({
  entry,
  mode,
  role,
  accessPreset,
  bookingEnabled,
  onBooked,
  onClose,
}: {
  entry: WaitlistEntry;
  mode: CommerceMode;
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  bookingEnabled: boolean;
  onBooked: (appointment: Appointment) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const formId = useId();
  const online = useOnline();
  const now = useNow(1000);
  const queries = useQueryClient();
  const toast = useToast();
  const [consent, setConsent] = useState<number | null>(null);
  const [waiver, setWaiver] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const [confirmClose, setConfirmClose] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const offer = entry.offer;
  const priceTerms = usePriceTerms(offer?.services ?? []);
  const intake = useBookingForms({
    serviceIds: entry.serviceIds,
    enabled: Boolean(offer) && entry.canManage,
    team: mode === "admin",
    subjectKey: entry.clientId,
    clientId: mode === "admin" ? entry.clientId : undefined,
  });
  const packet: WaitlistAccept | null =
    offer && intake.ready && !intake.query.isFetching
      ? {
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
        }
      : null;
  const {
    mutation: accept,
    disabled,
    uncertain,
  } = usePolicySubmission(
    packet,
    async (reviewed) => {
      if (!reviewed) throw new Error("Complete the current forms");
      try {
        return await api().waitlist.accept(mode, entry.id, reviewed);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "intake_required") void intake.refresh();
          if (error.status === 429) setRetryAt(Date.now() + (error.retryAfterSeconds ?? 30) * 1000);
        }
        throw error;
      }
    },
    (result) => {
      toast.success(t("waitlist.accepted"));
      void queries.invalidateQueries({ queryKey: ["waitlist"] });
      void invalidateCommerce(queries);
      onBooked(result.appointment);
    },
    blocksBookingVerification,
  );
  if (!offer) return null;
  const variablePrice = offer.services.some((s) => s.priceType === "variable");
  const expired = Date.parse(offer.expiresAt) <= now.getTime();
  const allowed =
    bookingEnabled &&
    entry.canManage &&
    (mode !== "client" || priceTerms.accepted) &&
    (!offer.policy.enabled ||
      (mode === "client"
        ? consent === offer.policy.version &&
          (!variablePrice || offer.policy.depositKind === "fixed")
        : permissionsFor(role, accessPreset).refunds && waiver.trim().length >= 8));
  const canSubmit =
    online &&
    !accept.isPending &&
    now.getTime() >= retryAt &&
    (uncertain || (!expired && allowed && packet !== null));
  const dirty =
    intake.dirty ||
    waiver.trim() !== "" ||
    consent !== null ||
    (priceTerms.required && priceTerms.accepted);
  const close = () => {
    if (accept.isPending) return;
    if (uncertain || dirty) setConfirmClose(true);
    else onClose();
  };
  const leaveWarning = disabled ? t("waitlist.leaveUnconfirmed") : undefined;
  return (
    <>
      <UnsavedGuard dirty={disabled || dirty} description={leaveWarning} />
      <Sheet
        open
        onOpenChange={(open) => !open && close()}
        title={t("waitlist.offerTitle")}
        size="lg"
        footer={
          <div className="space-y-3">
            {uncertain && (
              <p role="status" className="text-sm text-warning-fg">
                {t("waitlist.unconfirmed")}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                form={formId}
                type="submit"
                loading={accept.isPending}
                disabled={!canSubmit}
                className="max-w-full whitespace-normal!"
              >
                {t(uncertain ? "waitlist.retryBooking" : "waitlist.accept")}
              </Button>
            </div>
          </div>
        }
      >
        <form
          id={formId}
          method="post"
          className="min-w-0 space-y-4"
          aria-label={t("waitlist.offerTitle")}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) accept.mutate();
          }}
        >
          <fieldset disabled={disabled} className="min-w-0 space-y-4">
            <legend className="sr-only">{t("waitlist.offerTitle")}</legend>
            <BookingForms state={intake} />
            {mode === "client" && (
              <PriceTermsConsent state={priceTerms} disabled={accept.isPending} />
            )}
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
                price: totalPriceLabel(
                  t,
                  locale,
                  offer.services,
                  offer.priceCents,
                  offer.currency,
                  true,
                ),
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
          </fieldset>
          {expired && !uncertain && (
            <p role="status" className="text-warning-fg">
              {t("waitlist.expired")}
            </p>
          )}
          {uncertain && blocksBookingVerification(accept.error) && (
            <ErrorState error={accept.error} />
          )}
          {!uncertain && accept.isError && (
            <>
              <ErrorState error={accept.error} />
              {accept.error instanceof ApiError &&
                ["invalid_state", "version_conflict"].includes(accept.error.code) && (
                  <p className="text-sm">{t("waitlist.changed")}</p>
                )}
            </>
          )}
        </form>
      </Sheet>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={t(uncertain ? "waitlist.leaveReview" : "admin.unsaved.title")}
        description={leaveWarning ?? t("admin.unsaved.body")}
        cancelLabel={t("admin.unsaved.stay")}
        confirmLabel={t(uncertain ? "waitlist.leaveReview" : "admin.unsaved.leave")}
        onConfirm={() => {
          if (uncertain) void queries.invalidateQueries({ queryKey: ["waitlist"] });
          onClose();
        }}
      />
    </>
  );
}
