import { type EmailDeliverySettings, emailDeliveryInputSchema } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { PasswordField, TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { UnsavedGuard } from "../unsaved-guard";

const queryKey = ["admin", "email-delivery"] as const;

export function EmailDelivery({ email }: { email: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api().admin.emailDelivery.get(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [savedMessage, setSavedMessage] = useState(false);
  const [draftBase, setDraftBase] = useState<EmailDeliverySettings | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const initial = draftBase ?? query.data;
  return (
    <section aria-labelledby="email-delivery-title" className="max-w-2xl space-y-4">
      <h2 id="email-delivery-title" className="text-heading">
        {t("emailDelivery.title")}
      </h2>
      <p className="text-sm text-muted">{t("emailDelivery.lead")}</p>
      {initial ? (
        <DeliveryFields
          key={`${initial.revision ?? "default"}:${reloadCount}`}
          initial={initial}
          latestRevision={query.data?.revision}
          email={email}
          onSaved={(settings) => {
            client.setQueryData<EmailDeliverySettings>(queryKey, (current) =>
              !current || current.revision === initial.revision ? settings : current,
            );
            void client.invalidateQueries({ queryKey });
            setDraftBase(null);
            setSavedMessage(true);
          }}
          onEdited={() => {
            setDraftBase((old) => old ?? initial);
            setSavedMessage(false);
          }}
          onTested={() => setSavedMessage(false)}
          onReload={async () => {
            const result = await query.refetch();
            if (!result.isSuccess) return false;
            setDraftBase(null);
            setReloadCount((current) => current + 1);
            return true;
          }}
        />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Skeleton className="h-48" />
      )}
      <p role="status" className="text-sm text-muted">
        {savedMessage && t("emailDelivery.saved")}
      </p>
    </section>
  );
}

function DeliveryFields({
  initial,
  latestRevision,
  email,
  onSaved,
  onEdited,
  onTested,
  onReload,
}: {
  initial: EmailDeliverySettings;
  latestRevision: EmailDeliverySettings["revision"] | undefined;
  email: string;
  onSaved: (settings: EmailDeliverySettings) => void;
  onEdited: () => void;
  onTested: () => void;
  onReload: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState(initial.settings.provider);
  const [encryption, setEncryption] = useState(
    initial.settings.provider === "smtp" ? initial.settings.encryption : "starttls",
  );
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<"save" | "test" | "reload" | null>(null);
  const [error, setError] = useState<
    | "emailDelivery.conflict"
    | "emailDelivery.invalid"
    | "emailDelivery.failed"
    | "emailDelivery.testFailed"
    | null
  >(null);
  const [tested, setTested] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const busy = useRef(false);
  const active = provider !== "inherit" && provider !== "disabled";
  const sender =
    provider === initial.settings.provider && "fromEmail" in initial.settings
      ? initial.settings
      : null;
  const smtp =
    provider === "smtp" && initial.settings.provider === "smtp" ? initial.settings : null;
  const needsSecret = !initial.hasSecret || provider !== initial.settings.provider;
  const stale = dirty && latestRevision !== initial.revision;
  const canTest =
    !dirty &&
    error !== "emailDelivery.conflict" &&
    (active || (provider === "inherit" && initial.serverEmailEnabled));

  function edited() {
    setDirty(true);
    setTested(false);
    setError(null);
    onEdited();
  }

  function validateField(target: EventTarget | null) {
    if (target instanceof HTMLInputElement)
      target.setAttribute("aria-invalid", String(!target.validity.valid));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !dirty || stale || error === "emailDelivery.conflict") return;
    const values = new FormData(event.currentTarget);
    const settings = active
      ? {
          provider,
          fromEmail: values.get("fromEmail"),
          fromName: values.get("fromName"),
          ...(provider === "smtp"
            ? {
                host: values.get("host"),
                port: Number(values.get("port")),
                encryption,
                username: values.get("username"),
              }
            : {}),
        }
      : { provider };
    const parsed = emailDeliveryInputSchema.safeParse({
      revision: initial.revision,
      settings,
      secret: values.get("secret") || undefined,
    });
    if (!parsed.success) {
      setError("emailDelivery.invalid");
      return;
    }
    busy.current = true;
    setPending("save");
    setError(null);
    try {
      onSaved(await api().admin.emailDelivery.save(parsed.data));
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "version_conflict"
          ? "emailDelivery.conflict"
          : failure instanceof ApiError && failure.code === "validation_error"
            ? "emailDelivery.invalid"
            : "emailDelivery.failed",
      );
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  async function test() {
    if (busy.current || !canTest) return;
    busy.current = true;
    setPending("test");
    setError(null);
    setTested(false);
    onTested();
    try {
      await api().admin.emailDelivery.test(initial.revision);
      setTested(true);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "version_conflict"
          ? "emailDelivery.conflict"
          : "emailDelivery.testFailed",
      );
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <>
      <UnsavedGuard dirty={dirty} preserveOnSearchChange />
      <form
        onSubmit={(event) => void save(event)}
        onInput={(event) => {
          if (event.target instanceof HTMLInputElement && event.target.hasAttribute("aria-invalid"))
            validateField(event.target);
          edited();
        }}
        onInvalid={(event) => validateField(event.target)}
        className="space-y-4"
      >
        <fieldset disabled={Boolean(pending)} className="min-w-0 space-y-4">
          <legend className="sr-only">{t("emailDelivery.title")}</legend>
          <SelectField
            label={t("emailDelivery.provider")}
            value={provider}
            options={[
              { value: "inherit", label: t("emailDelivery.inherit") },
              { value: "smtp", label: "SMTP" },
              { value: "gmail", label: "Gmail / Google Workspace" },
              { value: "resend", label: "Resend" },
              { value: "disabled", label: t("emailDelivery.disabled") },
            ]}
            onChange={(value) => {
              if (
                value === "inherit" ||
                value === "disabled" ||
                value === "smtp" ||
                value === "gmail" ||
                value === "resend"
              ) {
                setProvider(value);
                edited();
              }
            }}
          />
          {provider === "inherit" && (
            <p className="text-sm text-muted">
              {t(
                initial.serverEmailEnabled
                  ? "emailDelivery.serverReady"
                  : "emailDelivery.serverMissing",
              )}
            </p>
          )}
          {active && (
            <div key={provider} className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t("emailDelivery.sender")}
                name="fromEmail"
                type="email"
                defaultValue={sender?.fromEmail}
                maxLength={254}
                required
                aria-invalid={false}
              />
              <TextField
                label={t("emailDelivery.senderName")}
                name="fromName"
                defaultValue={sender?.fromName}
                maxLength={100}
                required
                aria-invalid={false}
              />
              {provider === "smtp" && (
                <>
                  <TextField
                    label={t("emailDelivery.host")}
                    name="host"
                    defaultValue={smtp?.host}
                    autoCapitalize="none"
                    maxLength={253}
                    required
                    aria-invalid={false}
                  />
                  <TextField
                    label={t("emailDelivery.port")}
                    name="port"
                    type="number"
                    defaultValue={smtp?.port ?? 587}
                    min={1}
                    max={65535}
                    required
                    aria-invalid={false}
                  />
                  <SelectField
                    label={t("emailDelivery.encryption")}
                    value={encryption}
                    options={[
                      { value: "starttls", label: "STARTTLS" },
                      { value: "tls", label: "TLS" },
                    ]}
                    onChange={(value) => {
                      setEncryption(value === "tls" ? "tls" : "starttls");
                      edited();
                    }}
                  />
                  <TextField
                    label={t("emailDelivery.username")}
                    name="username"
                    defaultValue={smtp?.username}
                    autoComplete="off"
                    maxLength={254}
                    required
                    aria-invalid={false}
                  />
                </>
              )}
              <PasswordField
                className="sm:col-span-2"
                label={t(
                  provider === "smtp"
                    ? "emailDelivery.smtpPassword"
                    : provider === "gmail"
                      ? "emailDelivery.gmailPassword"
                      : "emailDelivery.resendKey",
                )}
                hint={
                  !needsSecret
                    ? t("emailDelivery.keepSecret")
                    : provider === "gmail"
                      ? t("emailDelivery.gmailHint")
                      : provider === "resend"
                        ? t("emailDelivery.resendHint")
                        : undefined
                }
                name="secret"
                autoComplete="new-password"
                maxLength={1024}
                required={needsSecret}
                aria-invalid={false}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={!dirty || stale || error === "emailDelivery.conflict"}>
              {t(pending === "save" ? "emailDelivery.saving" : "emailDelivery.save")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canTest}
              onClick={() => void test()}
            >
              {t("emailDelivery.test")}
            </Button>
          </div>
        </fieldset>
      </form>
      {canTest && <p className="text-sm text-muted">{t("emailDelivery.testTo", { email })}</p>}
      <p role="status" className="text-sm text-muted">
        {tested && t("emailDelivery.testSent", { email })}
      </p>
      {(error || stale) && (
        <p role="alert" className="text-sm text-danger-fg">
          {t(stale ? "emailDelivery.conflict" : (error ?? "emailDelivery.failed"))}
        </p>
      )}
      {reloadFailed && (
        <p role="status" className="text-sm text-danger-fg">
          {t("emailDelivery.failed")}
        </p>
      )}
      {(stale || error === "emailDelivery.conflict") && (
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(pending)}
          onClick={async () => {
            setPending("reload");
            try {
              setReloadFailed(!(await onReload()));
            } finally {
              setPending(null);
            }
          }}
        >
          {t("emailDelivery.reload")}
        </Button>
      )}
    </>
  );
}
