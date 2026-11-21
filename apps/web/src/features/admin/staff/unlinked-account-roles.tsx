import { type UnlinkedAccountReview, type UserRole, userRoleSchema } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";

export function UnlinkedAccountRoles({ onOpenMember }: { onOpenMember: (id: string) => void }) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState<UserRole | "">("");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ account: UnlinkedAccountReview; role: UserRole }>();
  const lookup = useMutation({
    mutationFn: async (address: string) => {
      const account = await api().admin.lookupUnlinkedAccount(address);
      if (account.email !== address.toLowerCase()) throw new Error("Unexpected account lookup");
      return account;
    },
  });
  const save = useMutation({
    mutationFn: async ({ account, role }: NonNullable<typeof draft>) => {
      const result = await api().admin.setUnlinkedAccountRole({
        userId: account.userId,
        generation: account.generation,
        revision: account.revision,
        role,
      });
      if (
        result.userId !== account.userId ||
        result.role !== role ||
        (result.staffId !== null) !== (role === "staff") ||
        (role === "client" && result.clientId === null)
      )
        throw new Error("Unexpected account role acknowledgement");
      return result;
    },
    onSuccess: () => {
      lookup.reset();
      setChoice("");
      setOpen(false);
      for (const queryKey of [["admin"], ["staff"], ["availability"]]) {
        void queries.invalidateQueries({ queryKey });
      }
    },
  });
  const lookupAccount = lookup.data;
  const canReview = online && !save.isPending && !save.isError && !lookup.isPending;
  const availableRoles = userRoleSchema.options.filter(
    (role) =>
      lookupAccount &&
      role !== lookupAccount.role &&
      (role === "client" || lookupAccount.emailVerified),
  );
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h3 id={headingId} ref={heading} tabIndex={-1} className="font-semibold">
        {t("access.accounts.title")}
      </h3>
      <form
        method="post"
        action="/api/admin/accounts/lookup"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!online || !email.trim() || lookup.isPending || save.isPending) return;
          save.reset();
          setChoice("");
          lookup.mutate(email.trim());
        }}
      >
        <TextField
          label={t("access.accounts.email")}
          type="email"
          name="email"
          autoComplete="off"
          required
          value={email}
          disabled={lookup.isPending || save.isPending}
          onChange={(event) => {
            setEmail(event.target.value);
            setChoice("");
            lookup.reset();
            save.reset();
          }}
        />
        <Button
          type="submit"
          disabled={!online || lookup.isPending || save.isPending}
          loading={lookup.isPending}
        >
          {t("access.accounts.search")}
        </Button>
      </form>
      {lookup.isError && (
        <p role="alert" className="text-sm text-danger-fg">
          {t(
            lookup.error instanceof ApiError && lookup.error.code === "not_found"
              ? "access.accounts.notFound"
              : lookup.error instanceof ApiError && lookup.error.code === "validation_error"
                ? "access.accounts.invalidEmail"
                : "access.accounts.lookupFailed",
          )}
        </p>
      )}
      <div role="status" className="space-y-2">
        {lookupAccount && (
          <>
            <p className="break-all text-sm">
              {lookupAccount.name} · {lookupAccount.email}
            </p>
            <p className="text-sm">
              {t("access.currentRole", { role: t(`access.role.${lookupAccount.role}`) })}
            </p>
            {!lookupAccount.emailVerified && (
              <p className="text-sm text-muted">{t("access.accounts.verifyEmail")}</p>
            )}
          </>
        )}
      </div>
      {lookupAccount && (
        <div className="space-y-2">
          {availableRoles.length > 0 && (
            <div className="flex flex-wrap items-end gap-3">
              <SelectField
                label={t("access.newRole")}
                value={choice}
                disabled={!canReview}
                options={[
                  { value: "", label: t("access.chooseRole"), disabled: true },
                  ...availableRoles.map((role) => ({
                    value: role,
                    label: t(`access.role.${role}`),
                  })),
                ]}
                onChange={(value) => {
                  const selected = userRoleSchema.safeParse(value);
                  setChoice(selected.success ? selected.data : "");
                }}
              />
              <Button
                variant="secondary"
                type="button"
                disabled={!canReview || !choice || !availableRoles.includes(choice)}
                onClick={() => {
                  if (canReview && choice && availableRoles.includes(choice)) {
                    setDraft({ account: lookupAccount, role: choice });
                    setOpen(true);
                  }
                }}
              >
                {t("access.reviewRole")}
              </Button>
            </div>
          )}
        </div>
      )}
      {save.data && (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {t("access.roleSaved")}
          </p>
          {save.data.staffId && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (save.data?.staffId) onOpenMember(save.data.staffId);
              }}
            >
              {t("access.accounts.openCalendar")}
            </Button>
          )}
        </div>
      )}
      {draft && (
        <ConfirmDialog
          open={open}
          title={t("access.changeRole")}
          description={`${t("access.roleReview", {
            email: draft.account.email,
            role: t(`access.role.${draft.role}`),
          })} ${t(draft.role === "owner" ? "access.roleImpact.owner" : `access.accounts.impact.${draft.role}`)}`}
          returnFocus={heading}
          destructive
          pending={save.isPending}
          confirmDisabled={!canReview || draft.account.revision !== lookupAccount?.revision}
          confirmLabel={t("access.confirmRole")}
          cancelLabel={t("admin.cancel")}
          onOpenChange={(next) => {
            if (!next && !save.isPending) setOpen(false);
          }}
          onConfirm={() => {
            if (open && canReview && draft.account.revision === lookupAccount?.revision)
              save.mutate(draft);
          }}
        >
          {save.isError && (
            <p role="alert" className="mt-2 text-sm text-danger-fg">
              {t("access.accounts.saveFailed")}
            </p>
          )}
        </ConfirmDialog>
      )}
      {!open && save.isError && (
        <p role="alert" className="text-sm text-danger-fg">
          {t("access.accounts.saveFailed")}
        </p>
      )}
    </section>
  );
}
