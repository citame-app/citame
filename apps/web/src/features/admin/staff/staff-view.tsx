import {
  idSchema,
  localDateSchema,
  permissionsFor,
  type StaffAccessPreset,
  shiftWeekStart,
  teamShiftWeekStartSchema,
  type UserRole,
} from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { AccessPanel } from "./access-panel";
import { CapacityPanel } from "./capacity-panel";
import { DateShiftEditor } from "./date-shifts";
import { HoursEditor } from "./hours-editor";
import { StaffPortrait, StaffPortraitEditor } from "./staff-portrait";
import { StaffServices } from "./staff-services";
import { TeamList } from "./team-list";
import { TimeOffPanel } from "./time-off-panel";
import { UnlinkedAccountRoles } from "./unlinked-account-roles";

export interface StaffSearch {
  member?: string;
  section?: "shifts" | "resources" | "commissions";
  week?: string;
  tab: "hours" | "timeoff" | "dates" | "services";
}

export function validateStaffSearch(raw: Record<string, unknown>): StaffSearch {
  const member = idSchema.safeParse(raw.member);
  const date = localDateSchema.safeParse(raw.week);
  const week = date.success
    ? teamShiftWeekStartSchema.safeParse(shiftWeekStart(date.data))
    : undefined;
  const section = raw.section;
  return {
    ...(member.success ? { member: member.data } : {}),
    ...(section === "shifts" || section === "resources" || section === "commissions"
      ? { section }
      : {}),
    ...(week?.success ? { week: week.data } : {}),
    tab:
      raw.tab === "timeoff"
        ? "timeoff"
        : raw.tab === "dates"
          ? "dates"
          : raw.tab === "services"
            ? "services"
            : raw.tab === "hours" || section !== "shifts"
              ? "hours"
              : "dates",
  };
}

export function StaffView({
  search,
  onSearchChange,
  role,
  ownStaffId,
  actorUserId,
  accessPreset,
}: {
  search: StaffSearch;
  onSearchChange: (search: StaffSearch) => void;
  role: UserRole;
  ownStaffId: string | null;
  actorUserId?: string;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t } = useI18n();
  const staff = useQuery(adminStaffQuery);
  const permissions = permissionsFor(role, accessPreset);
  const memberId = permissions.editSchedules ? (search.member ?? null) : ownStaffId;

  if (permissions.editSchedules && !memberId) {
    return (
      <>
        <TeamList
          canManageAccounts={permissions.manageAccounts}
          onOpenMember={(member) => onSearchChange({ member, tab: search.tab })}
        />
        {permissions.manageAccounts && (
          <UnlinkedAccountRoles
            onOpenMember={(member) => onSearchChange({ member, tab: search.tab })}
          />
        )}
      </>
    );
  }
  if (staff.isPending) return <Skeleton className="h-96" />;
  if (
    staff.isError &&
    (!staff.data ||
      (staff.error instanceof ApiError &&
        (staff.error.status === 401 || staff.error.status === 403)))
  )
    return <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />;
  const member = staff.data?.find((m) => m.id === memberId);
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
        <div className="flex items-center gap-3">
          <StaffPortrait member={member} size={64} />
          <h2 className="font-display text-2xl font-semibold">{member.displayName}</h2>
        </div>
      </div>
      {permissions.editSchedules && (
        <StaffPortraitEditor key={`portrait-${member.id}`} member={member} />
      )}
      {permissions.manageAccounts && (
        <AccessPanel staffId={member.id} staffName={member.displayName} actorUserId={actorUserId} />
      )}
      <CapacityPanel key={member.id} staffId={member.id} editable={permissions.editSchedules} />
      <Tabs
        label={t("staff.tab.label")}
        items={[
          { value: "services", label: t("pos.services") },
          { value: "hours", label: t("staff.tab.hours") },
          { value: "timeoff", label: t("staff.tab.timeoff") },
          { value: "dates", label: t("shifts.title") },
        ]}
        value={search.tab}
        onValueChange={(tab) =>
          onSearchChange({
            ...(search.member ? { member: search.member } : {}),
            tab:
              tab === "timeoff"
                ? "timeoff"
                : tab === "dates"
                  ? "dates"
                  : tab === "services"
                    ? "services"
                    : "hours",
          })
        }
      >
        <TabPanel value="services">
          <StaffServices
            staffId={member.id}
            serviceIds={member.serviceIds}
            canEdit={permissions.editCatalog}
          />
        </TabPanel>
        <TabPanel value="hours">
          <HoursEditor key={member.id} staffId={member.id} editable={permissions.editSchedules} />
        </TabPanel>
        <TabPanel value="dates">
          <DateShiftEditor
            key={`${member.id}:${search.week ?? "current"}`}
            staffId={member.id}
            editable={permissions.editSchedules}
            initialWeek={search.week}
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
