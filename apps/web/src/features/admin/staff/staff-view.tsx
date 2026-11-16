import { idSchema, permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { AccessPanel } from "./access-panel";
import { DateShiftEditor } from "./date-shifts";
import { HoursEditor } from "./hours-editor";
import { TeamList } from "./team-list";
import { TimeOffPanel } from "./time-off-panel";

export interface StaffSearch {
  member?: string;
  tab: "hours" | "timeoff" | "dates";
}

export function validateStaffSearch(raw: Record<string, unknown>): StaffSearch {
  const member = idSchema.safeParse(raw.member);
  return {
    ...(member.success ? { member: member.data } : {}),
    tab: raw.tab === "timeoff" ? "timeoff" : raw.tab === "dates" ? "dates" : "hours",
  };
}

export function StaffView({
  search,
  onSearchChange,
  role,
  ownStaffId,
  accessPreset,
}: {
  search: StaffSearch;
  onSearchChange: (search: StaffSearch) => void;
  role: UserRole;
  ownStaffId: string | null;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t } = useI18n();
  const staff = useQuery(adminStaffQuery);
  const permissions = permissionsFor(role, accessPreset);
  const memberId = permissions.editSchedules ? (search.member ?? null) : ownStaffId;

  if (permissions.editSchedules && !memberId) {
    return (
      <TeamList
        canManageAccounts={permissions.manageAccounts}
        onOpenMember={(member) => onSearchChange({ member, tab: search.tab })}
      />
    );
  }
  if (staff.isPending) return <Skeleton className="h-96" />;
  if (staff.isError) return <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />;
  const member = staff.data.find((m) => m.id === memberId);
  if (!member)
    return <ErrorState error={new Error("not found")} onRetry={() => void staff.refetch()} />;

  return (
    <div className="space-y-5">
      <div>
        {permissions.editSchedules && (
          <Button
            variant="ghost"
            className="-ml-3"
            onClick={() => onSearchChange({ tab: search.tab })}
          >
            <ChevronLeftIcon width={18} height={18} />
            {t("staff.back")}
          </Button>
        )}
        <h2 className="font-display text-2xl font-semibold">{member.displayName}</h2>
      </div>
      {permissions.manageAccounts && <AccessPanel staffId={member.id} />}
      <Tabs
        label={t("staff.tab.label")}
        items={[
          { value: "hours", label: t("staff.tab.hours") },
          { value: "timeoff", label: t("staff.tab.timeoff") },
          { value: "dates", label: t("shifts.title") },
        ]}
        value={search.tab}
        onValueChange={(tab) =>
          onSearchChange({
            ...(search.member ? { member: search.member } : {}),
            tab: tab === "timeoff" ? "timeoff" : tab === "dates" ? "dates" : "hours",
          })
        }
      >
        <TabPanel value="hours">
          <HoursEditor key={member.id} staffId={member.id} editable={permissions.editSchedules} />
        </TabPanel>
        <TabPanel value="dates">
          <DateShiftEditor
            key={member.id}
            staffId={member.id}
            editable={permissions.editSchedules}
          />
        </TabPanel>
        <TabPanel value="timeoff">
          <TimeOffPanel
            key={member.id}
            staffId={member.id}
            editable={
              permissions.editSchedules || (permissions.editCalendar && member.id === ownStaffId)
            }
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
