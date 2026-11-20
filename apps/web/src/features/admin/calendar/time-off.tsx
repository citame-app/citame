import type { AdminStaff, ScheduleConflict } from "@sob/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SelectField } from "~/components/ui/select-field";
import { TimeOffSheet } from "~/features/admin/staff/time-off-panel";
import { useI18n } from "~/i18n/react";

export function CalendarTimeOff({
  staff,
  date,
  initialStaffId,
  absence,
  onClose,
  onConflicts,
}: {
  staff: AdminStaff[];
  date: string;
  initialStaffId?: string;
  absence: boolean;
  onClose: () => void;
  onConflicts: (conflicts: ScheduleConflict[]) => void;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [staffId, setStaffId] = useState(
    staff.find((member) => member.id === initialStaffId)?.id ?? staff[0]?.id ?? "",
  );
  if (!staffId) return null;
  return (
    <TimeOffSheet
      staffId={staffId}
      entry={null}
      onClose={onClose}
      title={t(absence ? "calendar.addAbsence" : "calendar.blockTime")}
      initialAllDay={absence}
      initialForm={{ startDate: date, endDate: date, startTime: "09:00", endTime: "09:30" }}
      staffSelector={
        <SelectField
          label={t("walkin.staff")}
          value={staffId}
          onChange={setStaffId}
          options={staff.map((member) => ({ value: member.id, label: member.displayName }))}
        />
      }
      onSaved={(conflicts) => {
        onConflicts(conflicts);
        void queries.invalidateQueries({ queryKey: ["admin", "time-off", staffId] });
        void queries.invalidateQueries({ queryKey: ["admin", "calendar"] });
        void queries.invalidateQueries({ queryKey: ["availability"] });
      }}
    />
  );
}
