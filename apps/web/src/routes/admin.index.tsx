import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/")({
  validateSearch: (search: Record<string, unknown>): { notice?: "forbidden" } =>
    search.notice === "forbidden" ? { notice: "forbidden" } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/admin/calendar", search, replace: true });
  },
});
