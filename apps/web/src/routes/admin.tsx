import type { MeResponse } from "@sob/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { adminGuard, sectionOfPath } from "~/features/admin/nav";
import { adminHead } from "~/features/admin/route-head";
import { AdminShell } from "~/features/admin/shell";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { resolveAccess } from "~/lib/auth/access";
import { bootstrapQuery } from "~/server/request";

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
  const accountId = session?.user.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const refreshAccess = useCallback(
    async (signal: AbortSignal) => {
      let current: MeResponse | null;
      try {
        current = await api().me(signal);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) return;
        current = null;
      }
      if (signal.aborted) return;
      const cached = queryClient.getQueryData(bootstrapQuery.queryKey);
      const prior = cached?.session;
      if (!cached || !prior || prior.user.id !== accountId) return;
      if (
        current?.user.id === prior.user.id &&
        current.user.role === prior.user.role &&
        current.staffId === prior.staffId &&
        current.accessPreset === prior.accessPreset
      )
        return;
      queryClient.setQueryData(bootstrapQuery.queryKey, { ...cached, session: current });
      await router.invalidate();
    },
    [accountId, queryClient, router],
  );
  if (!session) return null;
  return (
    <AdminShell
      key={session.user.id}
      role={session.user.role}
      accessPreset={session.accessPreset}
      staffId={session.staffId}
      refreshAccess={refreshAccess}
      active={sectionOfPath(pathname)}
    >
      <Outlet />
    </AdminShell>
  );
}
