import type { StaffAccessPreset, UserRole } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CalendarIcon } from "~/components/ui/icons";
import { Sheet } from "~/components/ui/sheet";
import { WaitlistView } from "~/features/waitlist/waitlist-view";
import { useI18n } from "~/i18n/react";
import { calendarWaitlistQuery } from "~/lib/admin-queries";
import { formatDateLong } from "~/lib/format";

export function CalendarWaitlist({
  fromDate,
  toDate,
  role,
  ownStaffId,
  accessPreset,
}: {
  fromDate: string;
  toDate: string;
  role: UserRole;
  ownStaffId: string | null;
  accessPreset?: StaffAccessPreset | null;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const range = { fromDate, toDate };
  const count = useQuery(calendarWaitlistQuery(range));
  const label = t("calendar.waitlist.open", { count: count.data ?? "…" });
  return (
    <>
      <button
        type="button"
        className="calendar-waitlist-link"
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <CalendarIcon width={16} />
        <span>{label}</span>
      </button>
      <Sheet
        dimBackground={false}
        open={open}
        onOpenChange={setOpen}
        title={t("waitlist.title")}
        description={
          fromDate === toDate
            ? formatDateLong(fromDate, locale)
            : `${formatDateLong(fromDate, locale)} – ${formatDateLong(toDate, locale)}`
        }
        footer={
          <Link
            to="/admin/waitlist"
            className="block text-center text-sm font-semibold text-accent-text"
            onClick={() => setOpen(false)}
          >
            {t("calendar.waitlist.manage")}
          </Link>
        }
      >
        {open && (
          <WaitlistView
            key={`${fromDate}:${toDate}`}
            mode="admin"
            role={role}
            ownStaffId={ownStaffId}
            accessPreset={accessPreset}
            initialDate={fromDate}
            calendarRange={range}
            onNavigate={() => setOpen(false)}
          />
        )}
      </Sheet>
    </>
  );
}
