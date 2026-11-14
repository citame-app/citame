import { idSchema, type UserRole } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { HoursEditor } from "./hours-editor";
import { TeamList } from "./team-list";
import { TimeOffPanel } from "./time-off-panel";

export interface StaffSearch {
  member?: string;
  tab: "hours" | "timeoff";
}

export function validateStaffSearch(raw: Record<string, unknown>): StaffSearch {
  const member = idSchema.safeParse(raw.member);
  return {
    ...(member.success ? { member: member.data } : {}),
    tab: raw.tab === "timeoff" ? "timeoff" : "hours",
  };
}

export function StaffView({
  search,
  onSearchChange,
  role,
  ownStaffId,
}: {
  search: StaffSearch;
  onSearchChange: (search: StaffSearch) => void;
  role: UserRole;
  ownStaffId: string | null;
}) {
  const { t } = useI18n();
  const staff = useQuery(adminStaffQuery);
  const memberId = role === "staff" ? ownStaffId : (search.member ?? null);

  if (role === "owner" && !memberId) {
    return <TeamList onOpenMember={(member) => onSearchChange({ member, tab: search.tab })} />;
  }
  if (staff.isPending) return <Skeleton className="h-96" />;
  if (staff.isError) return <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />;
  const member = staff.data.find((m) => m.id === memberId);
  if (!member)
    return <ErrorState error={new Error("not found")} onRetry={() => void staff.refetch()} />;

  return (
    <div className="space-y-5">
      <div>
        {role === "owner" && (
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
      <Tabs
        label={t("staff.tab.label")}
        items={[
          { value: "hours", label: t("staff.tab.hours") },
          { value: "timeoff", label: t("staff.tab.timeoff") },
        ]}
        value={search.tab}
        onValueChange={(tab) =>
          onSearchChange({
            ...(search.member ? { member: search.member } : {}),
            tab: tab === "timeoff" ? "timeoff" : "hours",
          })
        }
      >
        <TabPanel value="hours">
          <HoursEditor key={member.id} staffId={member.id} editable={role === "owner"} />
        </TabPanel>
        <TabPanel value="timeoff">
          <TimeOffPanel
            key={member.id}
            staffId={member.id}
            editable={role === "owner" || member.id === ownStaffId}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
