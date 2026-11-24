import {
  applyOpeningScheduleEdits,
  BUSINESS_AMENITIES,
  BUSINESS_DESCRIPTION_MAX_LENGTH,
  type BusinessProfile,
  type BusinessProfileChanges,
  businessProfileSchema,
  diffOpeningSchedule,
  EMPTY_BUSINESS_PROFILE,
  EMPTY_OPENING_SCHEDULE,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";
import { OpeningHoursEditor } from "./opening-hours-editor";

const queryKey = ["admin", "settings", "profile"] as const;
const fields = [
  { key: "category", maxLength: 80 },
  { key: "address", maxLength: 240, autoComplete: "address-line1" },
  { key: "phone", maxLength: 32, type: "tel", autoComplete: "tel" },
  { key: "email", maxLength: 254, type: "email", autoComplete: "email" },
  { key: "website", maxLength: 500, type: "url" },
  { key: "shop", maxLength: 500, type: "url" },
  { key: "instagram", maxLength: 500, type: "url" },
  { key: "rules", maxLength: 400 },
] as const;
type Snapshot = Awaited<ReturnType<ReturnType<typeof api>["admin"]["settings"]["reviewed"]>>;
type Draft = { base: Snapshot; changes: Partial<BusinessProfile> };

function rebaseDraft(draft: Draft, base: Snapshot): Draft | null {
  const { openingSchedule, ...otherChanges } = draft.changes;
  const changes: Partial<BusinessProfile> = otherChanges;
  if (openingSchedule) {
    const schedule = base.openingSchedule ?? EMPTY_OPENING_SCHEDULE;
    const edits = diffOpeningSchedule(
      draft.base.openingSchedule ?? EMPTY_OPENING_SCHEDULE,
      openingSchedule,
    );
    const next = edits && applyOpeningScheduleEdits(schedule, edits);
    if (next && diffOpeningSchedule(schedule, next)) changes.openingSchedule = next;
  }
  return Object.keys(changes).length ? { base, changes } : null;
}

export function BusinessProfileForm() {
  const query = useQuery({
    queryKey,
    queryFn: () => api().admin.settings.reviewed(),
  });
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Skeleton className="h-56" />
    );
  return <ProfileEditor latest={query.data} />;
}

function ProfileEditor({ latest }: { latest: Snapshot }) {
  const { t } = useI18n();
  const online = useOnline();
  const toast = useToast();
  const queries = useQueryClient();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Set<string>>(() => new Set());
  const base = draft?.base ?? latest;
  const form = {
    ...EMPTY_BUSINESS_PROFILE,
    ...base.businessProfile,
    openingSchedule: base.openingSchedule ?? EMPTY_OPENING_SCHEDULE,
    ...draft?.changes,
  };
  const stale =
    draft && (base.revision !== latest.revision || base.generation !== latest.generation);
  const save = useMutation({
    mutationFn: (changes: BusinessProfileChanges) =>
      api().admin.settings.saveProfile({
        generation: base.generation,
        expectedRevision: base.revision,
        changes,
      }),
    onSuccess: (next) => {
      queries.setQueryData(queryKey, next);
      setDraft(null);
      toast.success(t("settings.saved"));
      void queries.invalidateQueries({ queryKey: ["admin", "settings"] });
      void queries.invalidateQueries({ queryKey: ["salon"] });
      void router.invalidate();
    },
  });
  const reload = useMutation({
    mutationFn: () => api().admin.settings.reviewed(),
    onSuccess: (next) => {
      queries.setQueryData(queryKey, next);
      setDraft((current) => (current ? rebaseDraft(current, next) : null));
      save.reset();
    },
  });
  const conflict =
    stale || (save.error instanceof ApiError && save.error.code === "version_conflict");
  function edit<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setDraft((current) => {
      const snapshot = current?.base ?? latest;
      const changes = { ...current?.changes };
      const original: Partial<BusinessProfile> = {
        ...snapshot.businessProfile,
        openingSchedule: snapshot.openingSchedule ?? EMPTY_OPENING_SCHEDULE,
      };
      if (JSON.stringify(value) === JSON.stringify(original[key])) delete changes[key];
      else changes[key] = value;
      return Object.keys(changes).length ? { base: snapshot, changes } : null;
    });
    setErrors((current) => new Set([...current].filter((field) => field !== key)));
    if (save.isSuccess) save.reset();
  }
  if (!base.businessProfile) return <p role="status">{t("settings.profile.unavailable")}</p>;
  return (
    <form
      ref={formRef}
      className="max-w-2xl space-y-5"
      aria-labelledby="business-profile-heading"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft || !online || conflict || save.isPending || reload.isPending) return;
        const normalized = Object.fromEntries(
          Object.entries(draft.changes).map(([key, value]) => [
            key,
            typeof value === "string" ? value.trim() || null : value,
          ]),
        );
        const parsed = businessProfileSchema.partial().safeParse(normalized);
        if (!parsed.success) {
          setErrors(new Set(parsed.error.issues.map((issue) => String(issue.path[0]))));
          queueMicrotask(() =>
            formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          );
          return;
        }
        setErrors(new Set());
        const { openingSchedule, ...changes } = parsed.data;
        const edits =
          openingSchedule &&
          diffOpeningSchedule(base.openingSchedule ?? EMPTY_OPENING_SCHEDULE, openingSchedule);
        if (edits) save.mutate({ ...changes, openingScheduleEdits: edits });
        else if (Object.keys(changes).length) save.mutate(changes);
        else setDraft(null);
      }}
    >
      <UnsavedGuard dirty={!!draft} preserveOnSearchChange />
      <h2 id="business-profile-heading" className="text-heading">
        {t("settings.profile.title")}
      </h2>
      <p className="text-sm text-muted">{t("settings.profile.help")}</p>
      <fieldset disabled={save.isPending || reload.isPending} className="space-y-4">
        <legend className="sr-only">{t("settings.profile.title")}</legend>
        <TextAreaField
          name="description"
          label={t("settings.profile.description")}
          value={form.description ?? ""}
          rows={6}
          maxLength={BUSINESS_DESCRIPTION_MAX_LENGTH}
          error={errors.has("description") ? t("settings.profile.invalid") : undefined}
          onChange={(event) => edit("description", event.currentTarget.value || null)}
        />
        {fields.map((field) => (
          <TextField
            key={field.key}
            name={field.key}
            label={t(`settings.profile.${field.key}`)}
            value={form[field.key] ?? ""}
            maxLength={field.maxLength}
            type={"type" in field ? field.type : undefined}
            autoComplete={"autoComplete" in field ? field.autoComplete : undefined}
            error={errors.has(field.key) ? t("settings.profile.invalid") : undefined}
            onChange={(event) => edit(field.key, event.currentTarget.value || null)}
          />
        ))}
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">{t("settings.profile.amenities")}</legend>
          {BUSINESS_AMENITIES.map((item) => (
            <label key={item} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={item}
                checked={form.amenities.includes(item)}
                onChange={(event) =>
                  edit(
                    "amenities",
                    BUSINESS_AMENITIES.filter((choice) =>
                      choice === item
                        ? event.currentTarget.checked
                        : form.amenities.includes(choice),
                    ),
                  )
                }
              />
              {t(`settings.profile.${item}`)}
            </label>
          ))}
        </fieldset>
        <OpeningHoursEditor
          key={`${base.generation}:${base.revision}`}
          schedule={form.openingSchedule ?? EMPTY_OPENING_SCHEDULE}
          invalid={errors.has("openingSchedule")}
          onChange={(value) => edit("openingSchedule", value)}
        />
        {(["mobileService", "published"] as const).map((key) => (
          <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={key}
              checked={form[key]}
              onChange={(event) => edit(key, event.currentTarget.checked)}
            />
            {t(`settings.profile.${key}`)}
          </label>
        ))}
      </fieldset>
      {conflict && (
        <p role="alert" className="text-danger-fg">
          {t("settings.profile.conflict")}
        </p>
      )}
      {((save.isError && !conflict) || reload.isError) && (
        <p role="alert" className="text-danger-fg">
          {t(describeProblem(reload.error ?? save.error).messageKey)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={!draft || !online || !!conflict || save.isPending || reload.isPending}
        >
          {t("settings.save")}
        </Button>
        {conflict && (
          <Button
            type="button"
            variant="secondary"
            disabled={!online || reload.isPending}
            onClick={() => reload.mutate()}
          >
            {t("settings.profile.review")}
          </Button>
        )}
      </div>
    </form>
  );
}
