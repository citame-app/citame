import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { usePolicySubmission } from "~/features/admin/policy-submission";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

type Choice = {
  enabled: boolean;
  version: number;
  source: string | null;
  updatedAt: string | null;
};
export function MarketingConsent({
  clientId,
  mode = "admin",
  editable = false,
  onDirtyChange,
}: {
  clientId: string;
  mode?: "admin" | "self";
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const key = ["marketing-consent", mode, clientId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      mode === "self" ? api().marketing.ownConsent() : api().marketing.consent(clientId),
    refetchOnMount: "always",
  });
  const [dirty, setDirty] = useState({ email: false, sms: false });
  const changed = useCallback(
    (channel: "email" | "sms", value: boolean) =>
      setDirty((current) =>
        current[channel] === value ? current : { ...current, [channel]: value },
      ),
    [],
  );
  useEffect(() => {
    onDirtyChange?.(dirty.email || dirty.sms);
    return () => onDirtyChange?.(false);
  }, [dirty.email, dirty.sms, onDirtyChange]);
  return (
    <section className="space-y-4" aria-label={t("marketing.consentTitle")}>
      <h2 className="text-heading">{t("marketing.consentTitle")}</h2>
      <p className="max-w-2xl text-sm text-muted">{t("marketing.consentHelp")}</p>
      {query.isPending ? (
        <Skeleton className="h-40" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(["email", "sms"] as const).map((channel) => (
            <ConsentChoice
              key={`${clientId}:${channel}`}
              clientId={clientId}
              mode={mode}
              channel={channel}
              choice={query.data[channel]}
              editable={editable}
              onDirtyChange={changed}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function ConsentChoice({
  clientId,
  mode,
  channel,
  choice,
  editable,
  onDirtyChange,
}: {
  clientId: string;
  mode: "admin" | "self";
  channel: "email" | "sms";
  choice: Choice;
  editable: boolean;
  onDirtyChange: (channel: "email" | "sms", dirty: boolean) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [base, setBase] = useState(choice);
  const [enabled, setEnabled] = useState(choice.enabled);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState(false);
  const dirty = enabled !== base.enabled;
  const stale = choice.version > base.version;
  useEffect(() => {
    onDirtyChange(channel, dirty);
    return () => onDirtyChange(channel, false);
  }, [channel, dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && choice.version > base.version) {
      setBase(choice);
      setEnabled(choice.enabled);
    }
  }, [choice, dirty, base.version]);
  const {
    mutation: save,
    uncertain,
    disabled,
    changed,
  } = usePolicySubmission(
    {
      channel,
      enabled,
      version: base.version,
      source: mode === "self" ? "Client account choice" : source.trim(),
    },
    (input) =>
      mode === "self"
        ? api().marketing.setOwnConsent(input)
        : api().marketing.setConsent(clientId, input),
    (result) => {
      setBase(result[channel]);
      setEnabled(result[channel].enabled);
      setSource("");
      setSaved(true);
      void queries.invalidateQueries({ queryKey: ["marketing-consent", mode, clientId] });
      void queries.invalidateQueries({ queryKey: ["marketing"] });
    },
  );
  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-surface p-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold">
        {t(channel === "email" ? "marketing.email" : "marketing.sms")}
      </h3>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-accent"
          checked={enabled}
          disabled={!editable || disabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setSaved(false);
            changed();
          }}
        />
        {t(
          mode === "self"
            ? channel === "email"
              ? "marketing.allowEmail"
              : "marketing.allowSms"
            : channel === "email"
              ? "marketing.recordEmail"
              : "marketing.recordSms",
        )}
      </label>
      {base.updatedAt && (
        <p className="text-xs text-muted">
          {new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
          }).format(new Date(base.updatedAt))}
          {mode === "admin" && base.source ? ` · ${base.source}` : ""}
        </p>
      )}
      {mode === "admin" && editable && dirty && (
        <TextField
          label={t("marketing.consentSource")}
          value={source}
          maxLength={500}
          onChange={(event) => {
            setSource(event.target.value);
            changed();
          }}
          disabled={disabled}
        />
      )}
      {stale && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-warning-fg">
            {t("pos.profileChanged")}
          </p>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              setBase(choice);
              setEnabled(choice.enabled);
              setSource("");
              changed();
            }}
          >
            {t("admin.refresh")}
          </Button>
        </div>
      )}
      {uncertain && (
        <p role="alert" className="text-sm text-warning-fg">
          {t("timing.uncertain")}
        </p>
      )}
      {save.isError && <ErrorState error={save.error} />}
      {editable && (
        <Button
          type="submit"
          disabled={
            !online ||
            save.isPending ||
            (!uncertain && (!dirty || stale || (mode === "admin" && source.trim().length < 3)))
          }
          loading={save.isPending}
        >
          {t(uncertain ? "timing.retry" : "admin.save")}
        </Button>
      )}
      {saved && (
        <p role="status" className="text-sm text-success-fg">
          {t("marketing.consentSaved")}
        </p>
      )}
    </form>
  );
}
