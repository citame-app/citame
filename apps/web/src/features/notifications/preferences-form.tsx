import type { NotificationPreferences, UpdateNotificationPreferencesRequest } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

export const preferencesQueryKey = ["notification-preferences"] as const;

type Channel = "email" | "sms" | "whatsapp";
type Category = "transactional" | "reminder";

/** The request that turns `saved` into `draft`: only fields that differ. */
export function diffPreferences(
  saved: NotificationPreferences,
  draft: NotificationPreferences,
): UpdateNotificationPreferencesRequest {
  const request: UpdateNotificationPreferencesRequest = {};
  if (draft.locale !== saved.locale) request.locale = draft.locale;
  for (const channel of ["email", "sms", "whatsapp"] as const) {
    for (const category of ["transactional", "reminder"] as const) {
      const value = draft[channel]?.[category];
      if (value !== undefined && value !== saved[channel]?.[category]) {
        request[channel] = { ...request[channel], [category]: value };
      }
    }
  }
  return request;
}

function Group({
  legend,
  lead,
  missing,
  disabled,
  values,
  onChange,
}: {
  legend: string;
  lead?: string;
  missing?: string;
  disabled: boolean;
  values: Record<Category, boolean>;
  onChange: (category: Category, value: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const row = (category: Category, label: string) => (
    <label
      htmlFor={`${id}-${category}`}
      className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3.5 py-3 hover:bg-sunken has-[:disabled]:opacity-60"
    >
      <input
        id={`${id}-${category}`}
        type="checkbox"
        className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
        checked={values[category]}
        disabled={disabled}
        onChange={(event) => onChange(category, event.target.checked)}
      />
      <span className="text-[0.95rem] text-fg">{label}</span>
    </label>
  );
  return (
    <fieldset className="space-y-2" aria-describedby={lead || missing ? `${id}-note` : undefined}>
      <legend className="mb-1 text-heading">{legend}</legend>
      {(missing || lead) && (
        <p id={`${id}-note`} className="text-sm text-muted">
          {missing ?? lead}
        </p>
      )}
      {row("transactional", t("notify.transactional"))}
      {row("reminder", t("notify.reminder"))}
    </fieldset>
  );
}

/** A signed-in client's notification choices: per channel and category, plus message language. */
export function PreferencesForm() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: preferencesQueryKey,
    queryFn: () => api().notificationPreferences.get(),
  });
  const saved = query.data;
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const save = useMutation({
    mutationFn: (request: UpdateNotificationPreferencesRequest) =>
      api().notificationPreferences.update(request),
    onSuccess: (result) => {
      toast.success(t("notify.saved"));
      queryClient.setQueryData(preferencesQueryKey, result);
    },
    onError: () => toast.error(t("notify.failed")),
  });

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!saved || !draft) return <Skeleton className="h-72" />;

  const request = diffPreferences(saved, draft);
  const dirty = Object.keys(request).length > 0;
  const toggle = (channel: Channel) => (category: Category, value: boolean) =>
    setDraft({ ...draft, [channel]: { ...draft[channel], [category]: value } });

  return (
    <form
      noValidate
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save.mutate(request);
      }}
    >
      <SelectField
        label={t("notify.language")}
        value={draft.locale ?? ""}
        options={[
          { value: "", label: t("notify.language.default") },
          { value: "en", label: t("notify.language.en") },
          { value: "es-AR", label: t("notify.language.esAR") },
        ]}
        onChange={(value) =>
          setDraft({ ...draft, locale: value === "" ? null : (value as "en" | "es-AR") })
        }
      />
      <Group
        legend={t("notify.email.legend")}
        missing={draft.hasEmail ? undefined : t("notify.email.missing")}
        disabled={!draft.hasEmail}
        values={draft.email}
        onChange={toggle("email")}
      />
      <Group
        legend={t("notify.sms.legend")}
        lead={t("notify.sms.lead")}
        missing={draft.hasPhone ? undefined : t("notify.sms.missing")}
        disabled={!draft.hasPhone}
        values={draft.sms}
        onChange={toggle("sms")}
      />
      {draft.whatsapp && (
        <Group
          legend="WhatsApp"
          lead={t("notify.whatsapp.lead")}
          missing={draft.hasWhatsAppPhone ? undefined : t("notify.whatsapp.missing")}
          disabled={!draft.hasWhatsAppPhone}
          values={draft.whatsapp}
          onChange={toggle("whatsapp")}
        />
      )}
      <Button type="submit" size="lg" disabled={!dirty} loading={save.isPending}>
        {t("notify.save")}
      </Button>
    </form>
  );
}
