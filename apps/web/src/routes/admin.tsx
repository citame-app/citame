import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { adminGuard, sectionOfPath } from "~/features/admin/nav";
import { adminHead } from "~/features/admin/route-head";
import { AdminShell } from "~/features/admin/shell";
import { resolveAccess } from "~/lib/auth/access";

/** Staff and owner area: guard, role-based navigation shell and the `/admin/*` pages. */
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context, location }) => {
    const decision = resolveAccess("admin", context.session);
    if (decision.type === "signin") {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
    if (decision.type === "forbidden" || !context.session) throw redirect({ to: "/account" });
    const guard = adminGuard(
      location.pathname,
      context.session.user.role,
      context.session.accessPreset,
    );
    if (guard.type === "redirect") {
      throw redirect(
        guard.to === "/account"
          ? { to: "/account" }
          : { to: "/admin/calendar", search: { notice: guard.notice } },
      );
    }
  },
  head: adminHead("admin.title"),
  component: AdminLayout,
});

function AdminLayout() {
  const { session } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!session) return null;
  return (
    <AdminShell
      key={session.user.id}
      role={session.user.role}
      accessPreset={session.accessPreset}
      active={sectionOfPath(pathname)}
    >
      <Outlet />
    </AdminShell>
  );
}
