import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MyAppointments } from "~/features/account/my-appointments";

export const Route = createFileRoute("/account/")({
  validateSearch: (raw: Record<string, unknown>): { highlight?: string } =>
    typeof raw.highlight === "string" ? { highlight: raw.highlight } : {},
  component: AccountHome,
});

function AccountHome() {
  const { salon } = Route.useRouteContext();
  const { highlight } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <MyAppointments
      timeZone={salon.timezone}
      highlightId={highlight}
      onReschedule={(appointment) =>
        void navigate({
          to: "/account/appointments/$id/reschedule",
          params: { id: appointment.id },
        })
      }
    />
  );
}
