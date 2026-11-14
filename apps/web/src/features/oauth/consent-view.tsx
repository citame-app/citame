import { DESKTOP_CLIENT_ID, type OAuthScope, type UserRole } from "@sob/contracts";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { consentScopes, type OAuthRequest, redirectHost } from "./logic";

export interface ConsentClient {
  client_id: string;
  client_name?: string;
}

export interface ConsentViewProps {
  request: OAuthRequest;
  client: ConsentClient;
  role: UserRole;
  email: string;
  salonName?: string;
  /** Approves with the scopes left on; resolves to the URL the user agent must open next. */
  decide: (decision: { accept: true; scopes: OAuthScope[] }) => Promise<{ url: string }>;
  /** Denies; resolves to the redirect carrying `access_denied`. */
  deny?: () => Promise<{ url: string }>;
  navigate?: (url: string) => void;
}

/**
 * The OAuth consent screen. It is the one place a person decides what an app may do for them, so
 * it names the app, shows where they will land, flags apps nobody vouched for, lists each
 * permission as a real checkbox (reading is locked on, the rest can be switched off) and makes
 * Deny as easy to reach as Allow.
 */
export function ConsentView({
  request,
  client,
  role,
  email,
  salonName = "Sisters of Beauty",
  decide,
  deny,
  navigate = (url) => window.location.assign(url),
}: ConsentViewProps) {
  const { t } = useI18n();
  const groupId = useId();
  const scopes = consentScopes(request.scopes, role);
  const [granted, setGranted] = useState<Record<string, boolean>>(
    Object.fromEntries(scopes.map((s) => [s.scope, true])),
  );
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);

  const app = client.client_name?.trim() || null;
  const host = redirectHost(request.redirectUri);
  const firstParty = client.client_id === DESKTOP_CLIENT_ID;

  async function run(kind: "allow" | "deny") {
    setFailed(false);
    setPending(kind);
    try {
      const next =
        kind === "allow"
          ? await decide({
              accept: true,
              scopes: scopes.filter((s) => granted[s.scope]).map((s) => s.scope),
            })
          : await (deny ?? (async () => ({ url: "" })))();
      setDone(true);
      navigate(next.url);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-6 shadow-sm sm:p-8">
      <h1 className="font-display text-2xl font-semibold text-fg">
        {app ? t("oauth.consent.title", { app }) : t("oauth.consent.titleUnnamed")}
      </h1>
      <p className="mt-2 text-muted">
        {app
          ? t("oauth.consent.lead", { app, salon: salonName })
          : t("oauth.consent.leadUnnamed", { salon: salonName })}
      </p>
      <p className="mt-1 text-sm text-muted">
        {t("oauth.consent.signedInAs")} <strong className="text-fg">{email}</strong>
      </p>

      {!firstParty && (
        <p className="mt-5 rounded-md bg-sunken px-4 py-3 text-[0.95rem] text-fg">
          {t("oauth.consent.unverified")}
        </p>
      )}

      <fieldset className="mt-6" aria-describedby={`${groupId}-redirect`}>
        <legend className="mb-3 text-sm font-semibold text-fg">{t("oauth.consent.scopes")}</legend>
        <ul className="space-y-2">
          {scopes.map(({ scope, required }) => {
            const id = `${groupId}-${scope}`;
            return (
              <li key={scope}>
                <label
                  htmlFor={id}
                  className={cn(
                    "flex min-h-11 items-start gap-3 rounded-md border border-line px-3.5 py-3",
                    required ? "bg-sunken" : "cursor-pointer hover:bg-sunken",
                  )}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
                    checked={granted[scope] ?? false}
                    disabled={required || pending !== null}
                    onChange={(event) =>
                      setGranted((previous) => ({ ...previous, [scope]: event.target.checked }))
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.95rem] text-fg">
                      {t(`oauth.scope.${scope}`)}
                    </span>
                    {required && (
                      <span className="mt-0.5 block text-xs text-muted">
                        {t("oauth.consent.alwaysOn")}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {host && (
        <p id={`${groupId}-redirect`} className="mt-5 text-sm text-muted">
          {t("oauth.consent.redirect", { host })}
        </p>
      )}

      {failed && (
        <p
          role="alert"
          className="mt-5 rounded-md bg-danger-soft px-4 py-3 text-[0.95rem] font-medium text-danger-fg"
        >
          {t("oauth.consent.failed")}
        </p>
      )}
      {done && (
        <p role="status" className="mt-5 text-sm text-muted">
          {t("oauth.consent.working")}
        </p>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          variant="secondary"
          size="lg"
          loading={pending === "deny"}
          disabled={pending !== null}
          onClick={() => void run("deny")}
        >
          {t("oauth.consent.deny")}
        </Button>
        <Button
          size="lg"
          loading={pending === "allow"}
          disabled={pending !== null}
          onClick={() => void run("allow")}
        >
          {t("oauth.consent.allow")}
        </Button>
      </div>
    </div>
  );
}
