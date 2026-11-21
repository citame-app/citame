import { intakeBookingIdentity } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { intakeHistoryQueryKey } from "~/lib/api/intake-endpoints";
import { servicesQuery } from "~/lib/queries";
import { BookingForms, useBookingForms } from "./booking-forms";
import { IntakeQuestions } from "./questions";

export function IntakeRecord({
  clientId,
  onDirtyChange,
}: {
  clientId?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const [before, setBefore] = useState<string>();
  const history = useQuery({
    queryKey: [...intakeHistoryQueryKey, clientId ?? "self", before],
    queryFn: ({ signal }) => api().intake.history(clientId, before, signal),
  });
  const [responseId, setResponseId] = useState<string>();
  const [recording, setRecording] = useState(false);
  const response = useQuery({
    queryKey: ["intake", "response", responseId],
    queryFn: () => api().intake.response(responseId ?? ""),
    enabled: Boolean(responseId),
    gcTime: 0,
  });
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(value),
    );
  return (
    <section aria-label={t("intake.history")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("intake.history")}</h3>
        <Button variant="secondary" onClick={() => setRecording(true)}>
          {t("intake.record")}
        </Button>
      </div>
      {history.isPending && <Skeleton className="h-16" />}
      {history.isError && (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      )}
      {history.data?.submissions.length === 0 && <p className="text-muted">{t("intake.empty")}</p>}
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {history.data?.submissions.map((row) => (
          <li
            key={row.id}
            className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4"
          >
            <div className="min-w-0">
              <p className="font-medium break-words">{row.formTitle}</p>
              <p className="text-sm text-muted">
                {t("intake.version", { number: row.number })} · {date(row.createdAt)}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setResponseId(row.id)}>
              {t("intake.view")}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        {before && (
          <Button variant="ghost" onClick={() => setBefore(undefined)}>
            {t("intake.refresh")}
          </Button>
        )}
        {history.data?.nextCursor && (
          <Button
            variant="secondary"
            onClick={() => setBefore(history.data?.nextCursor ?? undefined)}
          >
            {t("intake.more")}
          </Button>
        )}
      </div>
      <Sheet
        open={Boolean(responseId)}
        onOpenChange={(open) => {
          if (!open) setResponseId(undefined);
        }}
        title={response.data?.revision.definition.title ?? t("intake.view")}
        description={t("intake.appendOnly")}
        footer={
          <Button variant="secondary" onClick={() => setResponseId(undefined)}>
            {t("intake.close")}
          </Button>
        }
      >
        {response.isPending && <Skeleton className="h-32" />}
        {response.isError && (
          <ErrorState error={response.error} onRetry={() => void response.refetch()} />
        )}
        {response.data && (
          <div className="space-y-5">
            <p className="text-sm text-muted">
              {t("intake.version", { number: response.data.revision.number })} ·{" "}
              {date(response.data.createdAt)} ·{" "}
              {t(response.data.source === "client" ? "intake.byClient" : "intake.byTeam")}
            </p>
            <p className="break-words whitespace-pre-wrap">
              {response.data.revision.definition.description}
            </p>
            <IntakeQuestions
              definition={response.data.revision.definition}
              answers={response.data.answers}
              readOnly
            />
          </div>
        )}
      </Sheet>
      {recording && (
        <RecordResponse
          clientId={clientId}
          onClose={() => setRecording(false)}
          onDirtyChange={onDirtyChange}
        />
      )}
    </section>
  );
}
function RecordResponse({
  clientId,
  onClose,
  onDirtyChange,
}: {
  clientId?: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const toast = useToast();
  const queries = useQueryClient();
  const services = useQuery(servicesQuery);
  const [ids, setIds] = useState<string[]>([]);
  const [discard, setDiscard] = useState(false);
  const forms = useBookingForms({
    serviceIds: ids,
    enabled: ids.length > 0,
    team: Boolean(clientId),
    clientId,
    subjectKey: clientId ?? "self",
    allowRecorded: false,
  });
  const keys = useRef(new Map<string, string>());
  const [completed, setCompleted] = useState(new Set<string>());
  const save = useMutation({
    mutationFn: async () => {
      if (!forms.ready) throw new Error("Confirm the current responses first");
      for (const packet of forms.payload.intakeResponses ?? []) {
        const signature = intakeBookingIdentity({ intakeResponses: [packet] });
        let key = keys.current.get(signature);
        if (!key) {
          key = crypto.randomUUID();
          keys.current.set(signature, key);
        }
        await api().intake.submit({ ...packet, idempotencyKey: key }, clientId);
        setCompleted((previous) => new Set([...previous, signature]));
      }
    },
    onSuccess: () => {
      toast.success(t("intake.responseSaved"));
      void queries.invalidateQueries({ queryKey: ["intake"] });
      onClose();
    },
  });
  useEffect(() => {
    onDirtyChange?.(forms.dirty || save.isPending);
  }, [forms.dirty, save.isPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const close = () => {
    if (save.isPending) return;
    if (forms.dirty) setDiscard(true);
    else onClose();
  };
  const hasNew = forms.payload.intakeResponses?.some(
    (packet) => !completed.has(intakeBookingIdentity({ intakeResponses: [packet] })),
  );
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={t("intake.record")}
        description={t("intake.forServices")}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={close} disabled={save.isPending}>
              {t("admin.cancel")}
            </Button>
            <Button
              loading={save.isPending}
              disabled={!online || !forms.ready || !hasNew}
              onClick={() => save.mutate()}
            >
              {t("intake.saveResponse")}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          {services.isError && (
            <ErrorState error={services.error} onRetry={() => void services.refetch()} />
          )}
          {services.data && (
            <CatalogChoices
              catalog={services.data}
              selected={ids}
              onChange={setIds}
              disabled={save.isPending}
            />
          )}
          <fieldset disabled={save.isPending}>
            <BookingForms state={forms} />
          </fieldset>
          {save.isError && <ErrorState error={save.error} />}
        </div>
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("intake.discard")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("intake.discard")}
        cancelLabel={t("admin.cancel")}
        destructive
        onConfirm={onClose}
      />
    </>
  );
}
