import type { BookingPolicy, BookingProtection, UserRole } from "@sob/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Sheet } from "~/components/ui/sheet";
import { CheckoutPanel } from "~/features/admin/commerce/checkout-panel";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { formatMoney } from "~/lib/format";

export function BookingPolicyConsent({
  policy,
  totalCents,
  acceptedVersion,
  onAccept,
}: {
  policy: BookingPolicy;
  totalCents: number;
  acceptedVersion: number | null;
  onAccept: (version: number | null) => void;
}) {
  const { t, locale } = useI18n();
  if (!policy.enabled) return null;
  const amount = Math.min(
    totalCents,
    policy.depositKind === "fixed"
      ? policy.depositValue
      : Math.max(1, Math.ceil((totalCents * policy.depositValue) / 10000)),
  );
  return (
    <section
      aria-label={t("protection.title")}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-heading">{t("protection.title")}</h2>
      <p>
        {t("protection.terms", {
          amount: formatMoney(amount, "EUR", locale),
          minutes: policy.holdMinutes,
          notice: policy.cancellationWindowMinutes,
          late: policy.lateCancellationBasisPoints / 100,
          noShow: policy.noShowBasisPoints / 100,
        })}
      </p>
      <p className="text-sm text-muted">{t("protection.termsExemption")}</p>
      <label className="flex min-h-11 items-start gap-3 py-2">
        <input
          type="checkbox"
          className="mt-1 size-5 shrink-0 accent-accent"
          checked={acceptedVersion === policy.version}
          onChange={(e) => onAccept(e.target.checked ? policy.version : null)}
        />
        <span>{t("protection.accept")}</span>
      </label>
      {acceptedVersion !== null && acceptedVersion !== policy.version && (
        <p role="alert">{t("protection.changed")}</p>
      )}
    </section>
  );
}

export function BookingProtectionNotice({
  protection,
  mode = "client",
  role = "client",
  receipt = true,
}: {
  protection: BookingProtection;
  mode?: CommerceMode;
  role?: UserRole;
  receipt?: boolean;
}) {
  const { t, locale, timeZone } = useI18n();
  const [open, setOpen] = useState(false);
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(value),
    );
  return (
    <section
      aria-label={t("protection.title")}
      className="space-y-2 rounded-xl border border-line bg-sunken p-4"
    >
      <p role="status" className="font-semibold">
        {t(`protection.state.${protection.state}`)}
      </p>
      {protection.depositCents > 0 && (
        <p>
          {t("protection.deposit", { amount: formatMoney(protection.depositCents, "EUR", locale) })}
        </p>
      )}
      {protection.state === "pending" && (
        <p>{t("protection.deadline", { date: date(protection.expiresAt) })}</p>
      )}
      {["pending", "confirmed"].includes(protection.state) && (
        <p className="text-sm">
          {t("protection.cutoff", { date: date(protection.cancellationCutoff) })}
        </p>
      )}
      {protection.feeCents > 0 && (
        <p>{t("protection.fee", { amount: formatMoney(protection.feeCents, "EUR", locale) })}</p>
      )}
      {protection.refundDueCents > 0 && (
        <p>
          {t("protection.refund", {
            amount: formatMoney(protection.refundDueCents, "EUR", locale),
          })}
        </p>
      )}
      {receipt && (
        <>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t("protection.receipt")}
          </Button>
          <Sheet open={open} onOpenChange={setOpen} title={t("commerce.receipt")} size="lg">
            {open && <CheckoutPanel id={protection.checkoutId} mode={mode} role={role} />}
          </Sheet>
        </>
      )}
    </section>
  );
}
