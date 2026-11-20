import type { CalendarServiceBadges } from "@sob/contracts";
import { useI18n } from "~/i18n/react";

/** Compact, non-interactive indicators inside the appointment's single keyboard target. */
export function AppointmentBadges({ badges }: { badges?: CalendarServiceBadges[] }) {
  const { t } = useI18n();
  if (!badges?.length) return null;
  const requested = badges.some((b) => b.requested);
  const paid = badges.every((b) => b.paid);
  const invoiced = badges.every((b) => b.invoiced);
  const source = badges.some((b) => b.billingSource === "booksy") ? "booksy" : "citame";
  const internal = badges.some((b) => b.internalNote);
  const customer = badges.some((b) => b.customerComment);
  const items = [
    ...(paid || invoiced
      ? [
          {
            kind: "billing",
            label: t(
              paid
                ? source === "booksy"
                  ? "badge.paidBooksy"
                  : "badge.paidCitame"
                : source === "booksy"
                  ? "badge.invoicedBooksy"
                  : "badge.invoicedCitame",
            ),
            path: "M8 15c1 1 2 1 4 1s4-1 4-3-2-3-4-3-4-1-4-3 2-3 4-3 3 0 4 1M12 2v18",
          },
        ]
      : []),
    ...(internal
      ? [
          {
            kind: "internal",
            label: t("badge.internal"),
            path: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
          },
        ]
      : []),
    ...(customer
      ? [{ kind: "customer", label: t("badge.customer"), path: "M4 3h16v13H9l-5 5V3M8 7h8M8 11h5" }]
      : []),
    ...(requested
      ? [
          {
            kind: "requested",
            label: t("badge.requested"),
            path: "M12 20S2 14 2 8a5 5 0 0 1 10-2A5 5 0 0 1 22 8c0 6-10 12-10 12Z",
          },
        ]
      : []),
  ];
  return (
    <span className="appointment-badges">
      {items.map((item) => (
        <span
          key={item.kind}
          role="img"
          aria-label={item.label}
          title={item.label}
          data-badge={item.kind}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill={item.kind === "requested" ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={item.path} />
          </svg>
        </span>
      ))}
    </span>
  );
}
