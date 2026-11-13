import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { createTranslator } from "~/i18n";
import { resolveAccess } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

/**
 * Staff and owner area. Phase 3b-2 builds the dashboard inside this layout: the guard, the shell
 * and the `/admin/*` routing are already in place.
 */
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context, location }) => {
    const decision = resolveAccess("admin", context.session);
    if (decision.type === "signin") {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
    if (decision.type === "forbidden") throw redirect({ to: "/account" });
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("admin.title"),
        description: t("admin.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <PageContainer width="max-w-6xl">
      <div className="py-8 sm:py-12">
        <Outlet />
      </div>
    </PageContainer>
  );
}
