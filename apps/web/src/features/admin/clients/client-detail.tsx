import { phoneSchema, type UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, clientDetailQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";
import { StatusBadge } from "../calendar/status-badge";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";
import { useNow } from "../use-now";

export function ClientDetail({
  clientId,
  role,
  onDeleted,
  now: fixedNow,
}: {
  clientId: string;
  role: UserRole;
  onDeleted: () => void;
  now?: Date;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ticking = useNow(60_000);
  const now = fixedNow ?? ticking;
  const query = useQuery(clientDetailQuery(clientId));
  const staff = useQuery(adminStaffQuery);
  const [form, setForm] = useState({ name: "", phone: "", notes: "" });
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const client = query.data?.client;
  // Reset the draft whenever the server copy changes (first load, after saving, after a refetch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the saved timestamp
  useEffect(() => {
    if (client)
      setForm({ name: client.name, phone: client.phone ?? "", notes: client.notes ?? "" });
  }, [client?.id, client?.updatedAt, client?.name, client?.phone, client?.notes]);

  const dirty =
    Boolean(client) &&
    (form.name !== (client?.name ?? "") ||
      form.phone !== (client?.phone ?? "") ||
      form.notes !== (client?.notes ?? ""));

  const save = useMutation({
    mutationFn: (changes: { name?: string; phone?: string | null; notes?: string | null }) =>
      api().admin.clients.update(clientId, changes),
    onSuccess: () => {
      toast.success(t("clients.detail.saved"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "client", clientId] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] });
    },
    onError: (error) =>
      toast.error(`${t("clients.detail.saveFailed")}. ${t(describeProblem(error).messageKey)}`),
  });

  const remove = useMutation({
    mutationFn: () => api().admin.clients.remove(clientId),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success(t("clients.delete.done"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] });
      onDeleted();
    },
    onError: (error) => {
      setConfirmDelete(false);
      if (error instanceof ApiError && error.code === "has_future_appointments") {
        setBlocked(true);
        return;
      }
      toast.error(t(describeProblem(error).messageKey));
    },
  });

  if (query.isPending) return <Skeleton className="h-96" />;
  if (query.isError || !client)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const staffName = (id: string) => staff.data?.find((s) => s.id === id)?.displayName ?? "";
  const appointments = query.data?.appointments ?? [];
  const upcoming = appointments
    .filter((a) => a.status === "booked" && Date.parse(a.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = appointments.filter((a) => !upcoming.includes(a));

  function submit() {
    if (!client) return;
    const next: { name?: string; phone?: string | null; notes?: string | null } = {};
    const found: typeof errors = {};
    if (form.name !== client.name) {
      if (form.name.trim() === "") found.name = t("clients.error.name");
      else next.name = form.name.trim();
    }
    if (form.phone !== (client.phone ?? "")) {
      if (form.phone.trim() === "") next.phone = null;
      else if (!phoneSchema.safeParse(form.phone).success) found.phone = t("clients.error.phone");
      else next.phone = form.phone.trim();
    }
    if (form.notes !== (client.notes ?? ""))
      next.notes = form.notes.trim() === "" ? null : form.notes;
    setErrors(found);
    if (Object.keys(found).length === 0 && Object.keys(next).length > 0) save.mutate(next);
  }

  const renderAppointments = (list: typeof appointments) => (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {list.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{a.services.map((s) => s.name).join(", ")}</p>
            <p className="text-sm text-muted">
              {formatDateLong(localDateOf(a.startsAt, timeZone), locale)},{" "}
              {formatTime(a.startsAt, timeZone, locale)} ·{" "}
              {t("clients.detail.with", { staff: staffName(a.staffId) })}
            </p>
          </div>
          <StatusBadge status={a.status} />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-8">
      <UnsavedGuard dirty={dirty} />
      <div>
        <Link
          to="/admin/clients"
          search={{ page: 1, sort: "name", order: "asc" }}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-accent-text hover:underline"
        >
          <ChevronLeftIcon width={18} height={18} />
          {t("clients.detail.back")}
        </Link>
        <h2 className="mt-1 font-display text-2xl font-semibold">{client.name}</h2>
        <p className="text-muted">
          {t("clients.detail.stats", { count: client.appointmentCount })}
        </p>
      </div>

      <form
        noValidate
        className="max-w-xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        aria-label={t("clients.detail.contact")}
      >
        <TextField
          label={t("clients.detail.name")}
          value={form.name}
          onChange={(e) => {
            setForm({ ...form, name: e.target.value });
            setErrors(({ name: _cleared, ...rest }) => rest);
          }}
          error={errors.name}
        />
        <TextField
          label={t("clients.detail.phone")}
          type="tel"
          value={form.phone}
          onChange={(e) => {
            setForm({ ...form, phone: e.target.value });
            setErrors(({ phone: _cleared, ...rest }) => rest);
          }}
          error={errors.phone}
        />
        <TextField label={t("clients.detail.email")} value={client.email ?? ""} readOnly />
        <TextAreaField
          label={t("clients.detail.notes")}
          hint={t("clients.detail.notes.hint")}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={5}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!dirty} loading={save.isPending}>
            {t("admin.save")}
          </Button>
          {dirty && <span className="text-sm text-warning-fg">{t("admin.unsaved.badge")}</span>}
        </div>
      </form>

      <section aria-labelledby="client-upcoming" className="space-y-3">
        <h3 id="client-upcoming" className="text-heading">
          {t("clients.detail.upcoming")}
        </h3>
        {upcoming.length > 0 ? (
          renderAppointments(upcoming)
        ) : (
          <p className="text-muted">{t("clients.detail.history.empty")}</p>
        )}
      </section>
      <section aria-labelledby="client-past" className="space-y-3">
        <h3 id="client-past" className="text-heading">
          {t("clients.detail.past")}
        </h3>
        {past.length > 0 ? (
          renderAppointments(past)
        ) : (
          <p className="text-muted">{t("clients.detail.history.empty")}</p>
        )}
      </section>

      {blocked && (
        <div
          role="alert"
          className="rounded-xl border border-danger-fg/40 bg-danger-soft p-4 text-danger-fg"
        >
          <p className="font-medium">{t("clients.delete.blocked.title")}</p>
          <p className="mt-1 text-sm">{t("clients.delete.blocked.body")}</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {upcoming.map((a) => (
              <li key={a.id}>
                {formatDateLong(localDateOf(a.startsAt, timeZone), locale)},{" "}
                {formatTime(a.startsAt, timeZone, locale)} -{" "}
                {a.services.map((s) => s.name).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {role === "owner" && (
        <div className="border-t border-line pt-6">
          <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
            {t("clients.delete")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        pending={remove.isPending}
        title={t("clients.delete.title", { name: client.name })}
        description={t("clients.delete.body")}
        confirmLabel={t("clients.delete.confirm")}
        cancelLabel={t("admin.cancel")}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
