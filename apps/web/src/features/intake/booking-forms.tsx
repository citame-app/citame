import {
  type CreateAppointmentRequest,
  type IntakeAnswers,
  validateIntakeAnswers,
} from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { IntakeQuestions } from "./questions";

type Draft = { answers: IntakeAnswers; confirmed: boolean; optional: boolean; recordedId?: string };
const EMPTY: Draft = { answers: {}, confirmed: false, optional: false };
export function useBookingForms({
  serviceIds,
  enabled,
  team = false,
  subjectKey,
  clientId,
  series = false,
  allowRecorded = true,
}: {
  serviceIds: string[];
  enabled: boolean;
  team?: boolean;
  subjectKey: string;
  clientId?: string;
  series?: boolean;
  allowRecorded?: boolean;
}) {
  const online = useOnline();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const query = useQuery({
    queryKey: ["intake", "requirements", subjectKey, clientId ?? null, serviceIds],
    queryFn: () => api().intake.requirements(serviceIds, clientId),
    enabled: enabled && serviceIds.length > 0,
    refetchOnWindowFocus: true,
    refetchInterval: 60000,
  });
  const forms = query.data?.forms ?? [];
  const key = (id: string) => `${subjectKey}:${id}`;
  const draftFor = (id: string) => drafts[key(id)] ?? EMPTY;
  const update = (id: string, change: Partial<Draft>) =>
    setDrafts((previous) => ({
      ...previous,
      [key(id)]: { ...(previous[key(id)] ?? EMPTY), ...change },
    }));
  const payload: Pick<
    CreateAppointmentRequest,
    "intakeReviewHash" | "intakeSubmissionIds" | "intakeResponses"
  > = { intakeReviewHash: query.data?.reviewHash, intakeSubmissionIds: [], intakeResponses: [] };
  let complete = true;
  for (const form of forms) {
    const draft = draftFor(form.id);
    if (!form.definition.requiredAtBooking && !draft.optional) continue;
    const recorded =
      allowRecorded &&
      query.data?.readyResponses.find(
        (response) => response.id === draft.recordedId && response.revisionId === form.id,
      );
    if (recorded) {
      payload.intakeSubmissionIds?.push(recorded.id);
      continue;
    }
    if (
      (team && !form.definition.allowTeamResponses) ||
      !draft.confirmed ||
      validateIntakeAnswers(form.definition, draft.answers).length > 0
    )
      complete = false;
    else
      payload.intakeResponses?.push({
        revisionId: form.id,
        confirmation: true,
        answers: draft.answers,
      });
  }
  const ready =
    !enabled || (serviceIds.length > 0 && query.isSuccess && !query.isError && online && complete);
  return {
    query,
    forms,
    draftFor,
    update,
    ready,
    payload,
    team,
    series,
    enabled,
    allowRecorded,
    refresh: () => query.refetch(),
    reset: () => setDrafts({}),
    dirty: forms.some(
      (form) => Object.keys(draftFor(form.id).answers).length > 0 || draftFor(form.id).confirmed,
    ),
  };
}
export function BookingForms({ state }: { state: ReturnType<typeof useBookingForms> }) {
  const { t, locale, timeZone } = useI18n();
  if (!state.enabled) return null;
  if (state.query.isPending && !state.query.data) return <Skeleton className="h-16" />;
  return (
    <section aria-label={t("intake.title")} className="space-y-4">
      {state.query.isError && (
        <ErrorState error={state.query.error} onRetry={() => void state.refresh()} />
      )}
      {state.forms.length > 0 && (
        <>
          <h3 className="text-heading">{t("intake.title")}</h3>
          <p className="text-sm text-muted">{t("intake.private")}</p>
          {state.series && (
            <p className="rounded-lg border border-line bg-sunken p-3 text-sm">
              {t("intake.series")}
            </p>
          )}
        </>
      )}
      {state.forms.map((form) => {
        const draft = state.draftFor(form.id);
        const enabled = form.definition.requiredAtBooking || draft.optional;
        const recorded = state.allowRecorded
          ? state.query.data?.readyResponses.find((response) => response.revisionId === form.id)
          : undefined;
        const useRecorded = Boolean(recorded && recorded.id === draft.recordedId);
        return (
          <fieldset
            key={form.id}
            disabled={state.query.isFetching || state.query.isError}
            className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
          >
            <legend className="max-w-full px-1 font-semibold break-words">
              {form.definition.title}
            </legend>
            <p className="text-sm text-muted">
              {t("intake.version", { number: form.number })}
              {form.definition.requiredAtBooking ? ` · ${t("intake.required")}` : ""}
            </p>
            {form.definition.description && (
              <p className="break-words whitespace-pre-wrap">{form.definition.description}</p>
            )}
            {!form.definition.requiredAtBooking && (
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 accent-accent"
                  checked={draft.optional}
                  onChange={(event) =>
                    state.update(form.id, { optional: event.target.checked, confirmed: false })
                  }
                />
                {t("intake.optional")}
              </label>
            )}
            {enabled && (
              <>
                {recorded && (
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-accent"
                      checked={useRecorded}
                      onChange={(event) =>
                        state.update(form.id, {
                          recordedId: event.target.checked ? recorded.id : undefined,
                          confirmed: false,
                        })
                      }
                    />
                    <span>
                      {t("intake.recorded", {
                        date: new Intl.DateTimeFormat(locale, {
                          dateStyle: "short",
                          timeStyle: "short",
                          timeZone,
                        }).format(new Date(recorded.createdAt)),
                      })}
                    </span>
                  </label>
                )}
                {!useRecorded &&
                  (state.team && !form.definition.allowTeamResponses ? (
                    <p role="note" className="text-sm text-muted">
                      {t("intake.customerOnly")}
                    </p>
                  ) : (
                    <>
                      <IntakeQuestions
                        definition={form.definition}
                        answers={draft.answers}
                        onChange={(answers) => state.update(form.id, { answers, confirmed: false })}
                      />
                      <label className="flex min-h-11 items-start gap-3 border-t border-line pt-4">
                        <input
                          type="checkbox"
                          className="mt-1 size-5 shrink-0 accent-accent"
                          checked={draft.confirmed}
                          onChange={(event) =>
                            state.update(form.id, { confirmed: event.target.checked })
                          }
                        />
                        <span>{t(state.team ? "intake.teamConfirm" : "intake.confirm")}</span>
                      </label>
                    </>
                  ))}
              </>
            )}
          </fieldset>
        );
      })}
      {state.forms.length > 0 && (
        <Button
          variant="ghost"
          loading={state.query.isFetching}
          onClick={() => void state.refresh()}
        >
          {t("intake.refresh")}
        </Button>
      )}
    </section>
  );
}
