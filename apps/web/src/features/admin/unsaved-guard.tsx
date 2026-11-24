import { useBlocker } from "@tanstack/react-router";
import { ConfirmDialog } from "~/components/ui/dialog";
import { useI18n } from "~/i18n/react";

/**
 * Put it next to a form: while `dirty`, leaving the page (links, back button, closing the tab)
 * asks first. The in-app part is a real dialog; the browser handles the tab-close prompt.
 */
export function UnsavedGuard({
  dirty,
  preserveOnSearchChange = false,
  description,
}: {
  dirty: boolean;
  preserveOnSearchChange?: boolean;
  description?: string;
}) {
  const { t } = useI18n();
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty && !(preserveOnSearchChange && current.pathname === next.pathname),
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") blocker.reset();
      }}
      destructive
      title={t("admin.unsaved.title")}
      description={description ?? t("admin.unsaved.body")}
      confirmLabel={t("admin.unsaved.leave")}
      cancelLabel={t("admin.unsaved.stay")}
      onConfirm={() => blocker.status === "blocked" && blocker.proceed()}
    />
  );
}
