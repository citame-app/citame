import {
  clientEmailChangeSchema,
  LIMITS,
  permissionsFor,
  phoneSchema,
  type StaffAccessPreset,
  type UpdateClientRequest,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { IntakeRecord } from "~/features/intake/record";
import { MarketingConsent } from "~/features/marketing/consent";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, clientDetailQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";
import { StatusBadge } from "../calendar/status-badge";
import { CheckoutPanel } from "../commerce/checkout-panel";
import { LoyaltyView } from "../commerce/loyalty-view";
import { PassesView } from "../commerce/passes-view";
import { Transactions } from "../commerce/transactions";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";
import { useNow } from "../use-now";
import { ClientControlsEditor } from "./client-controls";
import { ClientMerge } from "./client-merge";
import { ClientPhotos } from "./client-photos";
import { ContactDetailFields, contactDraft, parseContactDraft } from "./contact-details";

export function ClientDetail({
  clientId,
  role,
  onDeleted,
  now: fixedNow,
  accessPreset,
  initialTab = "appointments",
}: {
  clientId: string;
  role: UserRole;
  onDeleted: () => void;
  now?: Date;
  accessPreset?: StaffAccessPreset | null;
  initialTab?: "appointments" | "profile";
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const permissions = permissionsFor(role, accessPreset);
  const [tab, setTab] = useState<string>(initialTab);
  const [visited, setVisited] = useState(() => new Set<string>([initialTab]));
  const [receipt, setReceipt] = useState<string | null>(null);
  const selectTab = (value: string) => {
    setTab(value);
    setVisited((current) => new Set([...current, value]));
  };
  const queryClient = useQueryClient();
  const ticking = useNow(60_000);
  const now = fixedNow ?? ticking;
  const query = useQuery(clientDetailQuery(clientId));
  const staff = useQuery(adminStaffQuery);
  const [form, setForm] = useState({ name: "", phone: "", notes: "" });
  const [emailDraft, setEmailDraft] = useState<{
    clientId: string;
    value: string;
    expectedUpdatedAt: string;
  } | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [metaDraft, setMetaDraft] = useState(() => contactDraft());
  const [metaBase, setMetaBase] = useState(() => ({ id: "", version: 1, draft: contactDraft() }));
  const detailsDirty = JSON.stringify(metaDraft) !== JSON.stringify(metaBase.draft);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [controlsDirty, setControlsDirty] = useState(false);
  const [photosDirty, setPhotosDirty] = useState(false);
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [privacyDirty, setPrivacyDirty] = useState(false);
  const [mergeDirty, setMergeDirty] = useState(false);

  const client = query.data?.client;
  const reviewedEmail = emailDraft?.clientId === clientId ? emailDraft : null;
  const emailValue = reviewedEmail?.value ?? client?.email ?? "";
  const emailDirty = Boolean(reviewedEmail && emailValue.trim() !== (client?.email ?? ""));
  const staleEmail =
    emailDirty && (!client?.emailEditable || reviewedEmail?.expectedUpdatedAt !== client.updatedAt);
  const previousContact = useRef<{ id: string; name: string; phone: string; notes: string } | null>(
    null,
  );
  useEffect(() => {
    if (!client) return;
    const next = {
      id: client.id,
      name: client.name,
      phone: client.phone ?? "",
      notes: client.notes ?? "",
    };
    const previous = previousContact.current;
    if (!previous || previous.id !== client.id)
      setForm({ name: next.name, phone: next.phone, notes: next.notes });
    else
      setForm((current) => ({
        name: current.name === previous.name ? next.name : current.name,
        phone: current.phone === previous.phone ? next.phone : current.phone,
        notes: current.notes === previous.notes ? next.notes : current.notes,
      }));
    previousContact.current = next;
  }, [client]);
  useEffect(() => {
    if (
      client &&
      (metaBase.id !== client.id ||
        (!detailsDirty && (client.detailsVersion ?? 1) > metaBase.version))
    ) {
      const draft = contactDraft(client.contactDetails);
      setMetaDraft(draft);
      setMetaBase({ id: client.id, version: client.detailsVersion ?? 1, draft });
    }
  }, [client, detailsDirty, metaBase.id, metaBase.version]);
  const staleDetails = Boolean(client) && (client?.detailsVersion ?? 1) > metaBase.version;
  const dirty =
    Boolean(client) &&
    (detailsDirty ||
      emailDirty ||
      form.name !== (client?.name ?? "") ||
      form.phone !== (client?.phone ?? "") ||
      form.notes !== (client?.notes ?? ""));

  const save = useMutation({
    mutationFn: (changes: UpdateClientRequest) => api().admin.clients.update(clientId, changes),
    onSuccess: (saved, changes) => {
      const draft = contactDraft(saved.contactDetails);
      setMetaDraft(draft);
      setMetaBase({ id: saved.id, version: saved.detailsVersion ?? 1, draft });
      if (changes.emailChange) {
        queryClient.setQueryData(clientDetailQuery(saved.id).queryKey, (current) =>
          current ? { ...current, client: saved } : current,
        );
        setEmailDraft((current) => (current?.clientId === saved.id ? null : current));
        void queryClient.invalidateQueries({ queryKey: ["marketing-consent", "admin", saved.id] });
      }
      toast.success(t("clients.detail.saved"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "client", clientId] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] });
    },
    onError: (error, changes) => {
      if (changes.emailChange && error instanceof ApiError && error.code === "version_conflict") {
        void queryClient.invalidateQueries({ queryKey: clientDetailQuery(clientId).queryKey });
      }
      toast.error(`${t("clients.detail.saveFailed")}. ${t(describeProblem(error).messageKey)}`);
    },
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
  const identity = query.data?.identity;
  const isAlias = Boolean(identity && identity.rootId !== clientId);
  const upcoming = appointments
    .filter((a) => a.status === "booked" && Date.parse(a.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = appointments.filter((a) => !upcoming.includes(a));

  function submit() {
    if (!client) return;
    const next: UpdateClientRequest = {};
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
    if (emailDirty && reviewedEmail && client.emailEditable && !staleEmail) {
      const parsed = clientEmailChangeSchema.safeParse({
        email: emailValue.trim() || null,
        expectedUpdatedAt: reviewedEmail.expectedUpdatedAt,
      });
      if (parsed.success && !emailInput.current?.validity.typeMismatch)
        next.emailChange = parsed.data;
      else {
        found.email = t("clients.detail.emailInvalid");
        if (!found.name && !found.phone) emailInput.current?.focus();
      }
    }
    if (form.notes !== (client.notes ?? ""))
      next.notes = form.notes.trim() === "" ? null : form.notes;
    if (detailsDirty) {
      const parsed = parseContactDraft(metaDraft);
      if (!parsed.success) {
        for (const issue of parsed.error.issues)
          found[String(issue.path[0])] = t("pos.invalidField");
      } else {
        next.contactDetails = parsed.data;
        next.detailsVersion = metaBase.version;
      }
    }
    setErrors(found);
    if (
      !staleDetails &&
      !staleEmail &&
      Object.keys(found).length === 0 &&
      Object.keys(next).length > 0
    )
      save.mutate(next);
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
    <div className="min-w-0 space-y-8">
      <UnsavedGuard
        dirty={
          dirty ||
          detailsDirty ||
          controlsDirty ||
          photosDirty ||
          intakeDirty ||
          privacyDirty ||
          mergeDirty
        }
      />
      <div>
        <Link
          to="/admin/clients"
          search={{ page: 1, sort: "name", order: "asc" }}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-accent-text hover:underline"
        >
          <ChevronLeftIcon width={18} height={18} />
          {t("clients.detail.back")}
        </Link>
        <h2 className="mt-1 break-words font-display text-2xl font-semibold [overflow-wrap:anywhere]">
          {client.name}
        </h2>
        <p className="text-muted">
          {t("clients.detail.stats", { count: client.appointmentCount })}
        </p>
      </div>

      {isAlias && identity && (
        <div
          role="status"
          className="max-w-xl space-y-2 rounded-xl border border-line bg-surface p-4"
        >
          <p>{t("merge.alias")}</p>
          <Link
            to="/admin/clients/$id"
            params={{ id: identity.rootId }}
            className="inline-flex min-h-11 items-center text-accent-text underline"
          >
            {t("merge.openSurvivor")}
          </Link>
        </div>
      )}
      <dl className="client-summary">
        <div>
          <dt>{t("admin.nav.calendar")}</dt>
          <dd>{appointments.length}</dd>
        </div>
        <div>
          <dt>{t("calendar.status.no_show")}</dt>
          <dd>{appointments.filter((row) => row.status === "no_show").length}</dd>
        </div>
        <div>
          <dt>{t("calendar.status.cancelled")}</dt>
          <dd>{appointments.filter((row) => row.status === "cancelled").length}</dd>
        </div>
        <div>
          <dt>{t("clients.col.lastVisit")}</dt>
          <dd className="text-sm!">
            {client.lastVisitAt
              ? formatDateLong(localDateOf(client.lastVisitAt, timeZone), locale)
              : t("clients.never")}
          </dd>
        </div>
      </dl>
      <nav className="commerce-section-nav" aria-label={client.name}>
        {[
          { value: "appointments", label: t("admin.nav.calendar") },
          { value: "profile", label: t("pos.profile") },
          { value: "photos", label: t("clientPhotos.title") },
          { value: "documents", label: t("pos.documents") },
          { value: "privacy", label: t("marketing.consentTitle") },
          ...(permissions.commerce
            ? [
                { value: "payments", label: t("pos.payments") },
                { value: "loyalty", label: t("loyalty.title") },
                { value: "packages", label: t("pos.packages") },
                { value: "memberships", label: t("pos.memberships") },
              ]
            : []),
        ].map((item) => (
          <button
            type="button"
            key={item.value}
            aria-pressed={tab === item.value}
            onClick={() => selectTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div hidden={tab !== "profile"}>
        <fieldset disabled={isAlias || mergeDirty} className="min-w-0 space-y-8">
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
                setMetaDraft((current) => ({ ...current, firstName: "", lastName: "" }));
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
            {client.emailEditable ? (
              <TextField
                ref={emailInput}
                label={t("clients.detail.contactEmail")}
                hint={t("clients.detail.contactEmailHelp")}
                type="email"
                name="contact-email"
                autoComplete="off"
                maxLength={LIMITS.email}
                value={emailValue}
                readOnly={save.isPending}
                error={errors.email}
                onChange={(event) => {
                  const value = event.target.value;
                  setEmailDraft(
                    value === (client.email ?? "")
                      ? null
                      : {
                          clientId,
                          value,
                          expectedUpdatedAt: reviewedEmail?.expectedUpdatedAt ?? client.updatedAt,
                        },
                  );
                  setErrors(({ email: _cleared, ...rest }) => rest);
                }}
              />
            ) : (
              <TextField label={t("clients.detail.email")} value={client.email ?? ""} readOnly />
            )}
            {staleEmail && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-danger-fg" role="status">
                  {t("clients.detail.emailStale")}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setEmailDraft(null);
                    setErrors(({ email: _cleared, ...rest }) => rest);
                  }}
                >
                  {t("clients.detail.useCurrentEmail")}
                </Button>
              </div>
            )}
            <TextAreaField
              label={t("clients.detail.notes")}
              hint={t("clients.detail.notes.hint")}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={5}
            />
            <fieldset
              className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"
              disabled={save.isPending}
            >
              <legend className="px-1 text-sm font-semibold">{t("pos.additionalInfo")}</legend>
              <ContactDetailFields
                value={metaDraft}
                errors={errors}
                onChange={(key, value) => {
                  const draft = { ...metaDraft, [key]: value };
                  setMetaDraft(draft);
                  if (key === "firstName" || key === "lastName")
                    setForm((current) => ({
                      ...current,
                      name: [draft.firstName.trim(), draft.lastName.trim()]
                        .filter(Boolean)
                        .join(" "),
                    }));
                  setErrors({ ...errors, [key]: "" });
                  save.reset();
                }}
              />
            </fieldset>
            {staleDetails && (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-warning-fg">
                  {t("pos.profileChanged")}
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const draft = contactDraft(client.contactDetails);
                    setMetaDraft(draft);
                    setMetaBase({ id: client.id, version: client.detailsVersion ?? 1, draft });
                  }}
                >
                  {t("admin.refresh")}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={!dirty || staleDetails || staleEmail}
                loading={save.isPending}
              >
                {t("admin.save")}
              </Button>
              {dirty && <span className="text-sm text-warning-fg">{t("admin.unsaved.badge")}</span>}
            </div>
          </form>

          <ClientControlsEditor clientId={clientId} onDirtyChange={setControlsDirty} />
        </fieldset>

        {identity && (
          <details className="max-w-xl rounded-xl border border-line bg-surface p-4">
            <summary className="min-h-11 cursor-pointer font-semibold">
              {t("merge.originals")}
            </summary>
            <ul className="mt-3 space-y-4">
              {identity.profiles.map((profile) => (
                <li
                  key={profile.id}
                  className="min-w-0 space-y-1 break-words [overflow-wrap:anywhere]"
                >
                  <p className="font-medium">{profile.name}</p>
                  <p className="text-sm">{profile.email}</p>
                  <p className="text-sm">{profile.phone}</p>
                  {profile.notes && (
                    <p className="whitespace-pre-wrap text-sm text-muted">{profile.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {role === "owner" && (
          <ClientMerge
            clientId={clientId}
            clientName={client.name}
            disabled={
              isAlias ||
              dirty ||
              detailsDirty ||
              controlsDirty ||
              photosDirty ||
              intakeDirty ||
              privacyDirty
            }
            onDirtyChange={setMergeDirty}
          />
        )}
      </div>
      {visited.has("photos") && (
        <fieldset hidden={tab !== "photos"} disabled={isAlias || mergeDirty}>
          <ClientPhotos clientId={clientId} onDirtyChange={setPhotosDirty} />
        </fieldset>
      )}
      {visited.has("documents") && (
        <fieldset hidden={tab !== "documents"} disabled={isAlias || mergeDirty}>
          <IntakeRecord clientId={clientId} onDirtyChange={setIntakeDirty} />
        </fieldset>
      )}
      {visited.has("privacy") && (
        <fieldset hidden={tab !== "privacy"} disabled={isAlias || mergeDirty}>
          <MarketingConsent
            clientId={clientId}
            editable={permissions.deleteClients && !isAlias}
            onDirtyChange={setPrivacyDirty}
          />
        </fieldset>
      )}
      {visited.has("payments") && permissions.commerce && (
        <div hidden={tab !== "payments"}>
          {permissions.financialReports && !isAlias && (
            <Link
              to="/admin/reports"
              search={{ preset: "last30", client: clientId }}
              className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline"
            >
              {t("accounting.clientSales")}
            </Link>
          )}
          <Transactions clientId={clientId} onOpen={setReceipt} />
        </div>
      )}
      {visited.has("loyalty") && permissions.commerce && (
        <div hidden={tab !== "loyalty"}>
          <LoyaltyView mode="admin" role={role} accessPreset={accessPreset} clientId={clientId} />
        </div>
      )}
      {(["packages", "memberships"] as const).map(
        (value) =>
          visited.has(value) &&
          permissions.commerce && (
            <div key={value} hidden={tab !== value}>
              <PassesView
                mode="admin"
                role={role}
                accessPreset={accessPreset}
                clientId={clientId}
                kind={value === "packages" ? "package" : "membership"}
              />
            </div>
          ),
      )}
      <Sheet
        title={t("commerce.receipt")}
        open={Boolean(receipt)}
        onOpenChange={(next) => {
          if (!next) setReceipt(null);
        }}
        size="lg"
      >
        {receipt && <CheckoutPanel id={receipt} mode="admin" role={role} />}
      </Sheet>
      <div hidden={tab !== "appointments"} className="space-y-6">
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
      </div>
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
          <Button
            variant="secondary"
            disabled={isAlias || mergeDirty}
            onClick={() => setConfirmDelete(true)}
          >
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
