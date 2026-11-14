import type { ScheduleConflict } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { clientDetailQuery } from "~/lib/admin-queries";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";

function ClientName({ clientId }: { clientId: string }) {
  const query = useQuery(clientDetailQuery(clientId));
  return <>{query.data?.client.name ?? "..."}</>;
}

/**
 * Existing appointments that no longer fit a schedule change. They are never moved
 * automatically, so this is the owner's to-do list.
 */
export function ConflictList({ conflicts }: { conflicts: ScheduleConflict[] }) {
  const { t, locale, timeZone } = useI18n();
  if (conflicts.length === 0) return null;
  const title = t("conflicts.title", { count: conflicts.length });
  return (
    <section
      aria-label={title}
      className="rounded-xl border border-warning-fg/40 bg-warning-soft p-4 text-warning-fg"
    >
      <h3 className="flex items-center gap-2 font-semibold">
        <AlertIcon className="shrink-0" />
        {title}
      </h3>
      <p className="mt-1 text-sm">{t("conflicts.body")}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {conflicts.map((c) => (
          <li key={c.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              {formatDateLong(localDateOf(c.startsAt, timeZone), locale)},{" "}
              {formatTime(c.startsAt, timeZone, locale)}
            </span>
            <Link
              to="/admin/clients/$id"
              params={{ id: c.clientId }}
              className="inline-flex min-h-11 items-center underline"
            >
              <ClientName clientId={c.clientId} />
            </Link>
            <span>({c.reasons.map((r) => t(`conflicts.reason.${r}`)).join(", ")})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
