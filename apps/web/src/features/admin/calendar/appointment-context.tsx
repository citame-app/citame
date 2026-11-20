import type { AppointmentContextRow, CalendarAppointment } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextAreaField } from "~/components/ui/select-field";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { AppointmentBadges } from "./appointment-badges";
import { invalidateCalendarData } from "./cache";

const contextKey = (id: string) => ["admin", "appointment-context", id] as const;
type NoteValues = { note: string; requested: boolean };
type NoteDraft = NoteValues & {
  baseline: NoteValues & { appointmentVersion: number; version: number };
};

export function AppointmentContext({
  appointment,
  readOnly = false,
}: {
  appointment: CalendarAppointment;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const context = useQuery({
    queryKey: contextKey(appointment.id),
    queryFn: () => api().appointments.context(appointment.id),
  });
  const details = context.data;
  return (
    <section className="space-y-4" aria-label={t("badge.details")}>
      <h3 className="font-semibold">{t("badge.details")}</h3>
      {context.data?.businessMessage && (
        <div className="rounded-lg bg-sunken p-3 text-sm">
          <p className="mb-1 font-medium">{t("badge.businessMessage")}</p>
          <p className="whitespace-pre-wrap">{context.data.businessMessage}</p>
        </div>
      )}
      {context.data?.customerComment && (
        <div className="rounded-lg bg-sunken p-3 text-sm">
          <p className="mb-1 font-medium">{t("badge.customer")}</p>
          <p className="whitespace-pre-wrap">{context.data.customerComment}</p>
        </div>
      )}
      {context.isPending ? (
        <p role="status" className="text-sm text-muted">
          {t("admin.loading")}
        </p>
      ) : !details ? (
        <p role="alert" className="text-sm text-danger-fg">
          {t("badge.loadError")}
        </p>
      ) : (
        appointment.services.map((service, index) => (
          <ServiceContext
            // biome-ignore lint/suspicious/noArrayIndexKey: the frozen service position identifies this note in the API.
            key={`${appointment.id}:${index}`}
            appointment={appointment}
            appointmentVersion={details.appointmentVersion ?? appointment.version}
            position={index}
            name={service.name}
            row={details.rows.find((r) => r.servicePosition === index)}
            readOnly={readOnly}
          />
        ))
      )}
    </section>
  );
}
function ServiceContext({
  appointment,
  appointmentVersion,
  position,
  name,
  row,
  readOnly = false,
}: {
  appointment: CalendarAppointment;
  appointmentVersion: number;
  position: number;
  name: string;
  row?: AppointmentContextRow;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const badges = appointment.serviceBadges?.filter((b) => b.servicePosition === position);
  const latest = {
    appointmentVersion,
    version: row?.version ?? 0,
    note: row?.internalNote ?? "",
    requested: row
      ? Boolean(row.requestedStaffId)
      : (badges?.some((b) => b.requested) ?? false),
  };
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const values = draft ?? latest;
  const save = useMutation({
    mutationFn: ({ baseline, requested, note }: NoteDraft) =>
      api().appointments.updateContext(appointment.id, {
        appointmentVersion: baseline.appointmentVersion,
        servicePosition: position,
        version: baseline.version,
        ...(requested !== baseline.requested ? { requested } : {}),
        internalNote: note,
      }),
    onSuccess: (saved) => {
      queries.setQueryData<typeof saved>(contextKey(appointment.id), (current) => {
        if ((current?.appointmentVersion ?? 0) > (saved.appointmentVersion ?? 0)) {
          return current;
        }
        return saved;
      });
      setDraft(null);
      return invalidateCalendarData(queries);
    },
  });
  const conflicted = save.error instanceof ApiError && save.error.status === 409;
  function update(change: Partial<NoteValues>) {
    const baseline = draft?.baseline ?? latest;
    const next = { note: values.note, requested: values.requested, ...change };
    setDraft(
      next.note === baseline.note && next.requested === baseline.requested
        ? null
        : { ...next, baseline },
    );
    if (save.isError && !conflicted) save.reset();
  }
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold">{name}</p>
        <AppointmentBadges badges={badges} />
      </div>
      {row?.customerComment && (
        <div className="rounded-lg bg-sunken p-3 text-sm">
          <p className="mb-1 font-medium">{t("badge.customer")}</p>
          <p className="whitespace-pre-wrap">{row.customerComment}</p>
        </div>
      )}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-[var(--accent)]"
          checked={values.requested}
          disabled={readOnly || save.isPending}
          onChange={(e) => update({ requested: e.target.checked })}
        />
        <span>{t("badge.requested")}</span>
      </label>
      <TextAreaField
        label={t("badge.internal")}
        hint={t("badge.private")}
        value={values.note}
        onChange={(e) => update({ note: e.target.value })}
        maxLength={2000}
        readOnly={readOnly || save.isPending}
      />
      {save.isError && (
        <p role="alert" className="text-sm text-danger-fg">
          {t(conflicted ? "badge.saveConflict" : "badge.saveError")}
        </p>
      )}
      {!readOnly && (
        <Button
          variant="secondary"
          loading={save.isPending}
          disabled={!draft || conflicted}
          onClick={() => draft && save.mutate(draft)}
        >
          {t("badge.save")}
        </Button>
      )}
      {!readOnly && conflicted && (
        <Button
          variant="secondary"
          onClick={() => {
            void queries.invalidateQueries({
              queryKey: contextKey(appointment.id),
            });
            setDraft(null);
            save.reset();
          }}
        >
          {t("badge.discardDraft")}
        </Button>
      )}
    </div>
  );
}
