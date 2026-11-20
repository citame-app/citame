import {
  type OwnerSalonSettings,
  SLOT_GRANULARITIES,
  updateSalonSettingsRequestSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminSettingsQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";

interface Form {
  name: string;
  timezone: string;
  slotGranularityMinutes: string;
  minNoticeMinutes: string;
  maxDaysAhead: string;
  onlineBookingEnabled: boolean;
  /** Empty means the reminder is off. */
  reminderFirstLeadMinutes: string;
  reminderSecondLeadMinutes: string;
}

const toForm = (s: OwnerSalonSettings): Form => ({
  name: s.name,
  timezone: s.timezone,
  slotGranularityMinutes: String(s.slotGranularityMinutes),
  minNoticeMinutes: String(s.minNoticeMinutes),
  maxDaysAhead: String(s.maxDaysAhead),
  onlineBookingEnabled: s.onlineBookingEnabled ?? true,
  reminderFirstLeadMinutes: s.reminderFirstLeadMinutes?.toString() ?? "",
  reminderSecondLeadMinutes: s.reminderSecondLeadMinutes?.toString() ?? "",
});

const leadValue = (value: string) => (value.trim() === "" ? null : Number(value));

function timezones(current: string): string[] {
  const list =
    (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    ) ?? [];
  return list.includes(current) ? list : [current, ...list];
}

export function SettingsView({
  section = "all",
  onInvalidSection,
}: {
  section?: "all" | "business" | "booking" | "reminders";
  onInvalidSection?: (section: "business" | "booking" | "reminders") => void;
} = {}) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const query = useQuery(adminSettingsQuery);
  const [edits, setEdits] = useState<Partial<Form>>({});
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const saved = query.data;

  const save = useMutation({
    mutationFn: (changes: Record<string, unknown>) => api().admin.settings.update(changes),
    onSuccess: (result) => {
      toast.success(t("settings.saved"));
      setEdits({});
      queryClient.setQueryData(adminSettingsQuery.queryKey, result);
      void queryClient.invalidateQueries({ queryKey: ["salon"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      void router.invalidate();
    },
    onError: (error) =>
      toast.error(`${t("settings.saveFailed")}. ${t(describeProblem(error).messageKey)}`),
  });

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!saved) return <Skeleton className="h-96" />;

  const initial = toForm(saved);
  const form = { ...initial, ...edits };
  const dirty = (Object.keys(form) as (keyof Form)[]).some((key) => form[key] !== initial[key]);
  const set = <Key extends keyof Form>(key: Key, value: Form[Key]) => {
    setEdits(({ [key]: _previous, ...current }) =>
      value === initial[key] ? current : { ...current, [key]: value },
    );
    setErrors(({ [key]: _cleared, ...rest }) => rest);
  };

  function submit() {
    if (!dirty) return;
    const changes: Record<string, unknown> = {};
    if (form.name !== initial.name) changes.name = form.name.trim();
    if (form.timezone !== initial.timezone) changes.timezone = form.timezone;
    if (form.slotGranularityMinutes !== initial.slotGranularityMinutes)
      changes.slotGranularityMinutes = Number(form.slotGranularityMinutes);
    if (form.minNoticeMinutes !== initial.minNoticeMinutes)
      changes.minNoticeMinutes = Number(form.minNoticeMinutes);
    if (form.maxDaysAhead !== initial.maxDaysAhead)
      changes.maxDaysAhead = Number(form.maxDaysAhead);
    if (form.onlineBookingEnabled !== initial.onlineBookingEnabled)
      changes.onlineBookingEnabled = form.onlineBookingEnabled;
    if (form.reminderFirstLeadMinutes !== initial.reminderFirstLeadMinutes)
      changes.reminderFirstLeadMinutes = leadValue(form.reminderFirstLeadMinutes);
    if (form.reminderSecondLeadMinutes !== initial.reminderSecondLeadMinutes)
      changes.reminderSecondLeadMinutes = leadValue(form.reminderSecondLeadMinutes);
    const parsed = updateSalonSettingsRequestSchema.safeParse(changes);
    const found: typeof errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]) as keyof Form;
        found[key] = t(
          key === "name"
            ? "settings.error.name"
            : key === "timezone"
              ? "settings.error.timezone"
              : key === "minNoticeMinutes"
                ? "settings.error.minNotice"
                : key === "reminderFirstLeadMinutes" || key === "reminderSecondLeadMinutes"
                  ? "settings.error.reminder"
                  : "settings.error.maxDays",
        );
      }
    }
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first)
      onInvalidSection?.(
        first === "name" || first === "timezone"
          ? "business"
          : first.startsWith("reminder")
            ? "reminders"
            : "booking",
      );
    if (parsed.success) save.mutate(parsed.data);
  }

  return (
    <form
      noValidate
      className="settings-editor max-w-2xl space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <UnsavedGuard dirty={dirty} preserveOnSearchChange />
      <section
        hidden={section !== "all" && section !== "business"}
        className="space-y-4"
        aria-labelledby="settings-salon"
      >
        <h2 id="settings-salon" className="text-heading">
          {t("settings.section.salon")}
        </h2>
        <TextField
          label={t("settings.name")}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          error={errors.name}
          autoComplete="off"
        />
        <SelectField
          label={t("settings.timezone")}
          value={form.timezone}
          options={timezones(initial.timezone).map((zone) => ({
            value: zone,
            label: zone.replaceAll("_", " "),
          }))}
          onChange={(value) => set("timezone", value)}
          hint={t("settings.timezone.hint")}
          error={errors.timezone}
        />
      </section>
      <section
        hidden={section !== "all" && section !== "booking"}
        className="space-y-4"
        aria-labelledby="settings-booking"
      >
        <h2 id="settings-booking" className="text-heading">
          {t("settings.section.booking")}
        </h2>
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            role="switch"
            {...{ switch: "" }}
            checked={form.onlineBookingEnabled}
            aria-checked={form.onlineBookingEnabled}
            onChange={(event) => set("onlineBookingEnabled", event.currentTarget.checked)}
            aria-describedby="settings-online-booking-hint"
            className="mt-1 size-5 shrink-0 accent-accent"
          />
          <span className="text-sm font-medium">{t("settings.onlineBookingEnabled")}</span>
        </label>
        <p id="settings-online-booking-hint" className="text-sm text-muted">
          {t("settings.onlineBookingHint")}
        </p>
        <SelectField
          label={t("settings.granularity")}
          value={form.slotGranularityMinutes}
          options={SLOT_GRANULARITIES.map((m) => ({
            value: String(m),
            label: t("settings.granularity.option", { minutes: m }),
          }))}
          onChange={(value) => set("slotGranularityMinutes", value)}
          hint={t("settings.granularity.hint")}
        />
        <TextField
          label={t("settings.minNotice")}
          inputMode="numeric"
          value={form.minNoticeMinutes}
          onChange={(e) => set("minNoticeMinutes", e.target.value)}
          hint={t("settings.minNotice.hint")}
          error={errors.minNoticeMinutes}
        />
        <TextField
          label={t("settings.maxDays")}
          inputMode="numeric"
          value={form.maxDaysAhead}
          onChange={(e) => set("maxDaysAhead", e.target.value)}
          hint={t("settings.maxDays.hint")}
          error={errors.maxDaysAhead}
        />
      </section>
      <section
        hidden={section !== "all" && section !== "reminders"}
        className="space-y-4"
        aria-labelledby="settings-reminders"
      >
        <h2 id="settings-reminders" className="text-heading">
          {t("settings.section.reminders")}
        </h2>
        <p className="text-sm text-muted">{t("settings.reminders.lead")}</p>
        <TextField
          label={t("settings.reminderFirst")}
          inputMode="numeric"
          value={form.reminderFirstLeadMinutes}
          onChange={(e) => set("reminderFirstLeadMinutes", e.target.value)}
          hint={t("settings.reminderFirst.hint")}
          error={errors.reminderFirstLeadMinutes}
        />
        <TextField
          label={t("settings.reminderSecond")}
          inputMode="numeric"
          value={form.reminderSecondLeadMinutes}
          onChange={(e) => set("reminderSecondLeadMinutes", e.target.value)}
          hint={t("settings.reminderSecond.hint")}
          error={errors.reminderSecondLeadMinutes}
        />
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!dirty} loading={save.isPending}>
          {t("settings.save")}
        </Button>
        {dirty && <span className="text-sm text-warning-fg">{t("admin.unsaved.badge")}</span>}
      </div>
    </form>
  );
}
