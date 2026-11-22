import {
  BUSINESS_AMENITIES,
  type BusinessProfile,
  businessProfileSchema,
  EMPTY_BUSINESS_PROFILE,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";

const queryKey = ["admin", "settings", "profile"] as const;
const fields = [
  { key: "category", maxLength: 80 },
  { key: "description", maxLength: 600 },
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

export function BusinessProfileForm() {
  const { t } = useI18n();
  const query = useQuery({ queryKey, queryFn: () => api().admin.settings.reviewed() });
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Skeleton className="h-56" />
    );
  if (!query.data.businessProfile) return <p role="status">{t("settings.profile.unavailable")}</p>;
  return <ProfileEditor latest={query.data} />;
}

function ProfileEditor({ latest }: { latest: Snapshot }) {
  const { t } = useI18n();
  const online = useOnline();
  const toast = useToast();
  const queries = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Set<string>>(() => new Set());
  const base = draft?.base ?? latest;
  const form = { ...(base.businessProfile ?? EMPTY_BUSINESS_PROFILE), ...draft?.changes };
  const stale =
    draft && (base.revision !== latest.revision || base.generation !== latest.generation);
  const save = useMutation({
    mutationFn: (changes: Partial<BusinessProfile>) =>
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
      setDraft((current) => (current ? { base: next, changes: current.changes } : null));
      save.reset();
    },
  });
  const conflict =
    stale || (save.error instanceof ApiError && save.error.code === "version_conflict");
  function edit<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setDraft((current) => {
      const snapshot = current?.base ?? latest;
      const changes = { ...current?.changes };
      if (JSON.stringify(value) === JSON.stringify(snapshot.businessProfile?.[key]))
        delete changes[key];
      else changes[key] = value;
      return Object.keys(changes).length ? { base: snapshot, changes } : null;
    });
    setErrors((current) => new Set([...current].filter((field) => field !== key)));
    if (save.isSuccess) save.reset();
  }
  return (
    <form
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
          return;
        }
        setErrors(new Set());
        save.mutate(parsed.data);
      }}
    >
      <UnsavedGuard dirty={!!draft} preserveOnSearchChange />
      <h2 id="business-profile-heading" className="text-heading">
        {t("settings.profile.title")}
      </h2>
      <p className="text-sm text-muted">{t("settings.profile.help")}</p>
      <fieldset disabled={save.isPending || reload.isPending} className="space-y-4">
        <legend className="sr-only">{t("settings.profile.title")}</legend>
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
