import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";

export interface CheckInboxProps {
  email: string;
  /** Asks the server to send the confirmation link again. */
  onResend: () => Promise<void>;
  /** Seconds before another email can be requested (the server throttles too). */
  cooldownSeconds?: number;
}

/** "We sent you a link": shown after sign-up and when an unconfirmed address tries to sign in. */
export function CheckInbox({ email, onResend, cooldownSeconds = 60 }: CheckInboxProps) {
  const { t } = useI18n();
  const [cooldown, setCooldown] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<"sent" | "limited" | "failed" | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function resend() {
    setPending(true);
    setNotice(null);
    try {
      await onResend();
      setNotice("sent");
      setCooldown(cooldownSeconds);
    } catch (error) {
      if (error instanceof ApiError && error.code === "rate_limited") {
        setNotice("limited");
        setCooldown(error.retryAfterSeconds ?? cooldownSeconds);
      } else {
        setNotice("failed");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="check-inbox-title" className="space-y-4">
      <h2 id="check-inbox-title" className="text-heading">
        {t("auth.verify.title")}
      </h2>
      <p>{t("auth.verify.body", { email })}</p>
      <p className="text-muted">{t("auth.verify.spam")}</p>
      <div role="status" aria-live="polite" className="min-h-6 text-[0.95rem]">
        {notice === "sent" && <p>{t("auth.verify.resent")}</p>}
        {notice === "limited" && (
          <p className="text-danger-fg">
            {t("error.rateLimited.title")}. {t("error.rateLimited.body", { count: cooldown })}
          </p>
        )}
        {notice === "failed" && <p className="text-danger-fg">{t("error.generic.body")}</p>}
        {notice !== "limited" && cooldown > 0 && (
          <p className="text-muted">{t("auth.verify.wait", { count: cooldown })}</p>
        )}
      </div>
      <Button
        variant="secondary"
        fullWidth
        loading={pending}
        disabled={cooldown > 0}
        onClick={resend}
      >
        {t("auth.verify.resend")}
      </Button>
    </section>
  );
}
