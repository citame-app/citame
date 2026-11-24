import type { AppointmentContextRow, CalendarAppointment } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextAreaField } from "~/components/ui/select-field";
import { useI18n } from "~/i18n/react";
import { calendarEntryQueryKey } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { AppointmentBadges } from "./appointment-badges";
import {
  type CalendarServiceContextChange,
  calendarWriteKey,
  startCalendarWrite,
  usePendingCalendarWrites,
} from "./appointment-writes";
import { invalidateCalendarData } from "./cache";

const contextKey = (id: string) => ["admin", "appointment-context", id] as const;
type NoteValues = { note: string; requested: boolean };
type NoteDraft = Partial<NoteValues> & {
  baseline: { note: string; staffId: string; requestedStaffId: string | null };
};

export function AppointmentContext({
  appointment,
  staffName,
  readOnly = false,
}: {
  appointment: CalendarAppointment;
  staffName: string;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const context = useQuery({
    queryKey: contextKey(appointment.id),
    queryFn: ({ signal }) => api().appointments.context(appointment.id, signal),
  });
  const details = context.data;
  const writePending = usePendingCalendarWrites().has(appointment.id);
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
            staffName={staffName}
            appointmentVersion={details.appointmentVersion ?? appointment.version}
            position={index}
            name={service.name}
            row={details.rows.find((r) => r.servicePosition === index)}
            readOnly={readOnly || details.canEdit === false}
            defaultRequested={details.defaultRequested}
            refreshing={context.isFetching}
            writePending={writePending}
          />
        ))
      )}
    </section>
  );
}
function ServiceContext({
  appointment,
  staffName,
  appointmentVersion,
  position,
  name,
  row,
  readOnly = false,
  defaultRequested,
  refreshing,
  writePending,
}: {
  appointment: CalendarAppointment;
  staffName: string;
  appointmentVersion: number;
  position: number;
  name: string;
  row?: AppointmentContextRow;
  readOnly?: boolean;
  defaultRequested?: boolean;
  refreshing: boolean;
  writePending: boolean;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const badges = appointment.serviceBadges?.filter((b) => b.servicePosition === position);
  const latest = {
    staffId: appointment.staffId,
    requestedStaffId: row?.requestedStaffId ?? null,
    note: row?.internalNote ?? "",
    requested: row
      ? Boolean(row.requestedStaffId)
      : (defaultRequested ?? badges?.some((b) => b.requested) ?? false),
  };
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const values = {
    note: draft?.note ?? latest.note,
    requested: draft?.requested ?? latest.requested,
  };
  const noteChanged = draft?.note !== undefined && values.note.trim() !== latest.note.trim();
  const requestChanged =
    draft?.requested !== undefined &&
    (values.requested !== latest.requested ||
      (values.requested &&
        latest.requestedStaffId !== null &&
        latest.requestedStaffId !== latest.staffId));
  const noteOverlap = noteChanged && draft !== null && draft.baseline.note !== latest.note;
  const requestOverlap =
    draft?.requested !== undefined &&
    ((requestChanged && draft.baseline.requestedStaffId !== latest.requestedStaffId) ||
      (values.requested && draft.baseline.staffId !== latest.staffId));
  const rowVersion = row?.version ?? 0;
  const refresh = () =>
    Promise.all([
      queries.invalidateQueries({ queryKey: contextKey(appointment.id) }),
      queries.invalidateQueries({ queryKey: ["admin", "calendar"] }),
      queries.invalidateQueries({ queryKey: calendarEntryQueryKey(appointment.id) }),
    ]);
  const save = useMutation({
    mutationKey: calendarWriteKey,
    mutationFn: ({ appointment, context }: CalendarServiceContextChange) =>
      api().appointments.updateContext(appointment.id, {
        ...context,
        appointmentVersion: appointment.version,
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
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void refresh();
    },
  });
  const conflicted = save.isError && save.error instanceof ApiError && save.error.status === 409;
  const needsRefresh =
    conflicted &&
    (appointmentVersion < save.variables.appointment.version ||
      (appointmentVersion === save.variables.appointment.version &&
        rowVersion <= save.variables.context.version));
  // A new professional request only applies to the assignment currently shown in the drawer.
  const awaitingAssignment =
    draft?.requested !== undefined &&
    values.requested &&
    appointment.version !== appointmentVersion;
  const reviewRequired = noteOverlap || requestOverlap;
  const canSave =
    !readOnly &&
    !writePending &&
    !needsRefresh &&
    !awaitingAssignment &&
    !reviewRequired &&
    (noteChanged || requestChanged);

  function update(change: Partial<NoteValues>) {
    const note =
      change.note === undefined
        ? draft?.note
        : change.note === latest.note
          ? undefined
          : change.note;
    const requested =
      change.requested === undefined
        ? draft?.requested
        : change.requested === latest.requested
          ? undefined
          : change.requested;
    const nextBaseline = {
      ...latest,
      ...(draft?.note !== undefined ? { note: draft.baseline.note } : {}),
      ...(draft?.requested !== undefined
        ? { requestedStaffId: draft.baseline.requestedStaffId, staffId: draft.baseline.staffId }
        : {}),
    };
    setDraft(
      note === undefined && requested === undefined
        ? null
        : { note, requested, baseline: nextBaseline },
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
      <div role="status" className="text-sm empty:sr-only">
        {needsRefresh && t("badge.saveConflict")}
        {!needsRefresh && awaitingAssignment && t("badge.loadAssignment")}
        {!needsRefresh && !awaitingAssignment && reviewRequired && t("badge.reviewConflict")}
      </div>
      {save.isError && !conflicted && (
        <p role="alert" className="text-sm text-danger-fg">
          {t("badge.saveError")}
        </p>
      )}
      {reviewRequired && (
        <div className="space-y-2 rounded-lg bg-sunken p-3 text-sm">
          <p className="font-medium">{t("badge.savedDetails")}</p>
          {noteOverlap && (
            <p className="whitespace-pre-wrap break-words">
              {latest.note || t("drawer.notes.empty")}
            </p>
          )}
          {requestOverlap && (
            <p>
              {values.requested
                ? t("badge.assignedProfessionalChanged")
                : t("badge.savedPreferenceChanged")}
              {values.requested && staffName && (
                <span className="block font-medium">{staffName}</span>
              )}
            </p>
          )}
        </div>
      )}
      {!readOnly && (needsRefresh || awaitingAssignment) && (
        <Button variant="secondary" loading={refreshing} onClick={() => void refresh()}>
          {t("problem.reload")}
        </Button>
      )}
      {!readOnly && reviewRequired && !needsRefresh && !awaitingAssignment && (
        <Button
          variant="secondary"
          disabled={refreshing || writePending}
          onClick={() => {
            setDraft({
              note: noteChanged ? values.note : undefined,
              requested: requestChanged ? values.requested : undefined,
              baseline: latest,
            });
            save.reset();
          }}
        >
          {t("drawer.notes.keepDraft")}
        </Button>
      )}
      {!readOnly && (
        <Button
          variant="secondary"
          loading={save.isPending}
          disabled={!canSave}
          onClick={() => {
            if (!canSave) return;
            startCalendarWrite(
              queries,
              {
                appointment: {
                  id: appointment.id,
                  version: appointmentVersion,
                },
                context: {
                  servicePosition: position,
                  version: rowVersion,
                  ...(requestChanged ? { requested: values.requested } : {}),
                  internalNote: values.note,
                },
              },
              save.mutate,
            );
          }}
        >
          {t("badge.save")}
        </Button>
      )}
      {!readOnly && (needsRefresh || reviewRequired) && (
        <Button
          variant="secondary"
          disabled={writePending}
          onClick={() => {
            setDraft(null);
            save.reset();
            if (needsRefresh) void refresh();
          }}
        >
          {t("badge.discardDraft")}
        </Button>
      )}
    </div>
  );
}
