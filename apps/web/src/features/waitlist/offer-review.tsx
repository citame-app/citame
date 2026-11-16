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
import { BookingPolicyConsent } from "~/features/booking/protection";
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
  const expired = Date.parse(offer.expiresAt) <= now.getTime();
  const allowed =
    entry.canManage &&
    (!offer.policy.enabled ||
      (mode === "client"
        ? consent === offer.policy.version
        : permissionsFor(role, accessPreset).refunds && waiver.trim().length >= 8));
  return (
    <div className="min-w-0 space-y-4">
      <BookingForms state={intake} />
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
            <span className="shrink-0">{formatMoney(s.priceCents, s.currency, locale)}</span>
          </li>
        ))}
      </ul>
      <p className="font-semibold">
        {t("waitlist.price", { price: formatMoney(offer.priceCents, offer.currency, locale) })}
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
