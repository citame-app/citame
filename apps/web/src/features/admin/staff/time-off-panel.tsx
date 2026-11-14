import type { ScheduleConflict, TimeOff } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { ClockIcon, PlusIcon, TrashIcon } from "~/components/ui/icons";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { timeOffQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatTime, localDateOf } from "~/lib/format";
import { describeProblem } from "../problems";
import { ConflictList } from "./conflict-list";
import { type TimeOffForm, zonedTimeOff } from "./hours";

const emptyForm: TimeOffForm = { startDate: "", startTime: "09:00", endDate: "", endTime: "18:00" };

export function TimeOffPanel({ staffId, editable }: { staffId: string; editable: boolean }) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery(timeOffQuery(staffId));
  const [editing, setEditing] = useState<TimeOff | "new" | null>(null);
  const [removing, setRemoving] = useState<TimeOff | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "time-off", staffId] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "calendar"] });
    void queryClient.invalidateQueries({ queryKey: ["availability"] });
  };

  const remove = useMutation({
    mutationFn: (entry: TimeOff) => api().admin.staff.deleteTimeOff(staffId, entry.id),
    onSuccess: () => {
      toast.success(t("timeoff.deleted"));
      setRemoving(null);
      setConflicts([]);
      refresh();
    },
    onError: (error) => {
      setRemoving(null);
      toast.error(t(describeProblem(error).messageKey));
    },
  });

  if (query.isPending) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const entries = [...query.data].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const when = (entry: TimeOff) => {
    const from = `${formatDateWithYear(localDateOf(entry.startsAt, timeZone), locale)}, ${formatTime(entry.startsAt, timeZone, locale)}`;
    const to = `${formatDateWithYear(localDateOf(entry.endsAt, timeZone), locale)}, ${formatTime(entry.endsAt, timeZone, locale)}`;
    return t("timeoff.range", { from, to });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-heading">{t("timeoff.title")}</h3>
          <p className="text-muted">{t("timeoff.lead")}</p>
        </div>
        {editable && (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon />
            {t("timeoff.add")}
          </Button>
        )}
      </div>

      <ConflictList conflicts={conflicts} />

      {entries.length === 0 ? (
        <EmptyState
          title={t("timeoff.empty.title")}
          description={t("timeoff.empty.body")}
          icon={<ClockIcon width={24} height={24} />}
        />
      ) : (
        <ul
          aria-label={t("timeoff.title")}
          className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface"
        >
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{entry.reason ?? t("timeoff.title")}</p>
                <p className="text-sm text-muted">{when(entry)}</p>
              </div>
              {editable && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`${t("timeoff.edit")}: ${entry.reason ?? ""}`.trim()}
                    onClick={() => setEditing(entry)}
                  >
                    {t("admin.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`${t("timeoff.delete.confirm")} ${t("timeoff.title").toLowerCase()}: ${entry.reason ?? ""}`.trim()}
                    onClick={() => setRemoving(entry)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <TimeOffSheet
          key={editing === "new" ? "new" : editing.id}
          staffId={staffId}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setConflicts(result);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        destructive
        pending={remove.isPending}
        title={t("timeoff.delete.title")}
        description={t("timeoff.delete.body")}
        confirmLabel={t("timeoff.delete.confirm")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </div>
  );
}

function splitInstant(instant: string, timeZone: string) {
  return {
    date: localDateOf(instant, timeZone),
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant)),
  };
}

function TimeOffSheet({
  staffId,
  entry,
  onClose,
  onSaved,
}: {
  staffId: string;
  entry: TimeOff | null;
  onClose: () => void;
  onSaved: (conflicts: ScheduleConflict[]) => void;
}) {
  const { t, timeZone } = useI18n();
  const toast = useToast();
  const initial: TimeOffForm = entry
    ? (() => {
        const s = splitInstant(entry.startsAt, timeZone);
        const e = splitInstant(entry.endsAt, timeZone);
        return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
      })()
    : emptyForm;
  const [form, setForm] = useState<TimeOffForm>(initial);
  const [reason, setReason] = useState(entry?.reason ?? "");
  const [error, setError] = useState<"required" | "endBeforeStart" | null>(null);
  const [open, setOpen] = useState(true);

  const save = useMutation({
    mutationFn: async () => {
      const zoned = zonedTimeOff(form, timeZone);
      if (!zoned.ok) throw new Error(zoned.error);
      const trimmed = reason.trim();
      if (!entry) {
        return api().admin.staff.createTimeOff(staffId, {
          startsAt: zoned.startsAt,
          endsAt: zoned.endsAt,
          ...(trimmed ? { reason: trimmed } : {}),
        });
      }
      const changes: { startsAt?: string; endsAt?: string; reason?: string | null } = {};
      if (zoned.startsAt !== entry.startsAt) changes.startsAt = zoned.startsAt;
      if (zoned.endsAt !== entry.endsAt) changes.endsAt = zoned.endsAt;
      if (trimmed !== (entry.reason ?? "")) changes.reason = trimmed === "" ? null : trimmed;
      return api().admin.staff.updateTimeOff(staffId, entry.id, changes);
    },
    onSuccess: (result) => {
      toast.success(t("timeoff.saved"));
      onSaved(result.conflicts);
      setOpen(false);
      onClose();
    },
    onError: (e) => toast.error(t(describeProblem(e).messageKey)),
  });

  function submit() {
    const zoned = zonedTimeOff(form, timeZone);
    if (!zoned.ok) {
      setError(zoned.error);
      return;
    }
    setError(null);
    save.mutate();
  }

  const set = (key: keyof TimeOffForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      title={t(entry ? "timeoff.edit" : "timeoff.add")}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              onClose();
            }}
          >
            {t("admin.cancel")}
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {t("timeoff.save")}
          </Button>
        </div>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("timeoff.startDate")}
            type="date"
            value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
          <TextField
            label={t("timeoff.startTime")}
            type="time"
            value={form.startTime}
            onChange={(e) => set("startTime", e.target.value)}
          />
          <TextField
            label={t("timeoff.endDate")}
            type="date"
            value={form.endDate}
            onChange={(e) => set("endDate", e.target.value)}
          />
          <TextField
            label={t("timeoff.endTime")}
            type="time"
            value={form.endTime}
            onChange={(e) => set("endTime", e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger-fg">
            {t(error === "required" ? "timeoff.error.required" : "timeoff.error.endBeforeStart")}
          </p>
        )}
        <TextField
          label={t("timeoff.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoComplete="off"
        />
      </form>
    </Sheet>
  );
}
