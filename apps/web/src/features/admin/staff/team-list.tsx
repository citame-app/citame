import type { AdminStaff } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { ConfirmDialog } from "~/components/ui/dialog";
import { PasswordField, TextField } from "~/components/ui/field";
import { PlusIcon, UsersIcon } from "~/components/ui/icons";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { describeProblem } from "../problems";
import { BlockedPanel } from "./blocked-panel";

const helper = createColumnHelper<DataTableFeatures, AdminStaff>();

export function TeamList({ onOpenMember }: { onOpenMember: (id: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const staff = useQuery(adminStaffQuery);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<AdminStaff | null>(null);
  const [blocked, setBlocked] = useState<AdminStaff | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    void queryClient.invalidateQueries({ queryKey: ["staff"] });
    void queryClient.invalidateQueries({ queryKey: ["availability"] });
  };

  const setActive = useMutation({
    mutationFn: ({ member, active }: { member: AdminStaff; active: boolean }) =>
      api().admin.staff.update(member.id, { active }),
    onSuccess: (_saved, { member, active }) => {
      toast.success(t(active ? "staff.activated" : "staff.deactivated"));
      setDeactivating(null);
      if (blocked?.id === member.id) setBlocked(null);
      refresh();
    },
    onError: (error, { member }) => {
      setDeactivating(null);
      if (error instanceof ApiError && error.code === "has_future_appointments") {
        setBlocked(member);
        return;
      }
      toast.error(t(describeProblem(error).messageKey));
    },
  });

  const rows = useMemo(() => {
    const [sort] = sorting;
    const list = [...(staff.data ?? [])];
    const value = (m: AdminStaff) =>
      sort?.id === "services"
        ? m.serviceIds.length
        : sort?.id === "status"
          ? Number(m.active)
          : m.displayName.toLowerCase();
    if (sort)
      list.sort(
        (a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0) * (sort.desc ? -1 : 1),
      );
    return list;
  }, [staff.data, sorting]);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("displayName", {
          id: "name",
          header: t("staff.col.name"),
          meta: { cardTitle: true },
        }),
        helper.accessor("active", {
          id: "status",
          header: t("staff.col.status"),
          cell: (c) => (
            <Badge tone={c.getValue() ? "success" : "neutral"}>
              {t(c.getValue() ? "staff.status.active" : "staff.status.inactive")}
            </Badge>
          ),
        }),
        helper.accessor((m) => m.serviceIds.length, {
          id: "services",
          header: t("staff.col.services"),
          cell: (c) => t("staff.servicesCount", { count: c.getValue() }),
        }),
        helper.accessor((m) => m.userId !== null, {
          id: "login",
          header: t("staff.col.login"),
          enableSorting: false,
          cell: (c) => t(c.getValue() ? "staff.login.linked" : "staff.login.none"),
        }),
        helper.display({
          id: "actions",
          header: "",
          enableHiding: false,
          cell: (c) => {
            const member = c.row.original;
            return member.active ? (
              <Button variant="ghost" onClick={() => setDeactivating(member)}>
                {t("staff.deactivate")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                loading={setActive.isPending && setActive.variables?.member.id === member.id}
                onClick={() => setActive.mutate({ member, active: true })}
              >
                {t("staff.activate")}
              </Button>
            );
          },
        }),
      ]),
    [t, setActive],
  );

  if (staff.isError) return <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />;

  return (
    <div className="space-y-4">
      <DataTable
        label={t("staff.table")}
        columns={columns}
        data={rows}
        getRowId={(m) => m.id}
        total={rows.length}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        paginate={false}
        loading={staff.isPending}
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            {t("staff.new")}
          </Button>
        }
        sorting={sorting}
        onSortingChange={setSorting}
        onPageChange={() => {}}
        onRowOpen={(m) => onOpenMember(m.id)}
        empty={
          <EmptyState
            title={t("staff.empty.title")}
            description={t("staff.empty.body")}
            icon={<UsersIcon width={24} height={24} />}
          />
        }
      />
      {creating && <CreateAccountSheet onClose={() => setCreating(false)} onCreated={refresh} />}
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
        destructive
        pending={setActive.isPending}
        title={t("staff.deactivate.title", { name: deactivating?.displayName ?? "" })}
        description={t("staff.deactivate.body")}
        confirmLabel={t("staff.deactivate")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => deactivating && setActive.mutate({ member: deactivating, active: false })}
      />
      {blocked && (
        <BlockedPanel
          member={blocked}
          allStaff={staff.data ?? []}
          pending={setActive.isPending}
          onRetry={() => setActive.mutate({ member: blocked, active: false })}
          onClose={() => setBlocked(null)}
        />
      )}
    </div>
  );
}

function CreateAccountSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", displayName: "", email: "", password: "" });
  // Inviting is the default: the owner never has to pick, know or pass on someone's password.
  const [invite, setInvite] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<"name" | "email" | "password", string>>>({});
  const [open, setOpen] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      api().admin.staff.create({
        email: form.email.trim(),
        name: form.name.trim(),
        ...(invite ? {} : { password: form.password }),
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
      }),
    onSuccess: (created) => {
      toast.success(created.invited ? t("staff.create.invited") : t("staff.create.done"));
      onCreated();
      setOpen(false);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "invalid_state")
        setErrors({ email: t("staff.create.emailTaken") });
      else toast.error(t(describeProblem(error).messageKey));
    },
  });

  function submit() {
    const found: typeof errors = {};
    if (form.name.trim() === "") found.name = t("staff.create.error.name");
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) found.email = t("staff.create.error.email");
    if (!invite && form.password.length < 8) found.password = t("staff.create.error.password");
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate();
  }

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      title={t("staff.create.title")}
      description={t("staff.create.description")}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              onClose();
            }}
          >
            {t("admin.cancel")}
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            {t("staff.create.submit")}
          </Button>
        </div>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label={t("staff.create.name")}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          error={errors.name}
          autoComplete="off"
        />
        <TextField
          label={t("staff.create.displayName")}
          value={form.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          autoComplete="off"
        />
        <TextField
          label={t("staff.create.email")}
          type="email"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
          error={errors.email}
          autoComplete="off"
        />
        <div>
          <label className="flex min-h-11 items-start gap-3 text-[0.95rem]">
            <input
              type="checkbox"
              checked={invite}
              onChange={(e) => setInvite(e.target.checked)}
              className="mt-1 size-5 accent-[var(--accent)]"
              aria-describedby="invite-hint"
            />
            <span>{t("staff.create.inviteLabel")}</span>
          </label>
          <p id="invite-hint" className="ml-8 text-sm text-muted">
            {t("staff.create.inviteHint")}
          </p>
        </div>
        {!invite && (
          <PasswordField
            label={t("staff.create.password")}
            hint={t("staff.create.password.hint")}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            error={errors.password}
            autoComplete="new-password"
          />
        )}
      </form>
    </Sheet>
  );
}
