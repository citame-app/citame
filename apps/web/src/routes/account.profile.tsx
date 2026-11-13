import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProfileForm } from "~/features/account/profile-form";
import { useI18n } from "~/i18n/react";
import { bootstrapQuery } from "~/server/request";

export const Route = createFileRoute("/account/profile")({ component: ProfilePage });

function ProfilePage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  if (!session) return null;
  return (
    <section aria-labelledby="profile-title" className="max-w-lg">
      <h2 id="profile-title" className="text-heading">
        {t("account.profile.title")}
      </h2>
      <p className="mt-1 mb-6 text-muted">{t("account.profile.lead")}</p>
      <ProfileForm
        initial={{ name: session.user.name, email: session.user.email, phone: session.phone }}
        onSaved={(me) => {
          queryClient.setQueryData(bootstrapQuery.queryKey, (previous) =>
            previous ? { ...previous, session: me } : previous,
          );
          void router.invalidate();
        }}
      />
    </section>
  );
}
