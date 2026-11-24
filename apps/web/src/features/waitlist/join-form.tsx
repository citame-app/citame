import {
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
  type WaitlistInput,
  type WaitlistSourceEntry,
  waitlistInputSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useDebounced } from "~/features/admin/use-debounced";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { addDaysLocal, localDateOf } from "~/lib/format";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { type WaitlistViewer, waitlistUserKey } from "~/lib/waitlist-queries";

const unreviewedStaff = "unreviewed";

export interface JoinFormProps {
  mode: CommerceMode;
  role: UserRole;
  viewer: WaitlistViewer;
  accessPreset?: StaffAccessPreset | null;
  ownStaffId?: string | null;
  initialServices?: string[];
  initialStaff?: string;
  initialDate?: string;
  onJoined: () => void;
}
export function WaitlistJoinForm({
  mode,
  role,
  accessPreset,
  ownStaffId,
  viewer,
  initialServices = [],
  initialStaff,
  initialDate,
  imported,
  importRequiresPause = false,
  onJoined,
}: JoinFormProps & { imported?: WaitlistSourceEntry | null; importRequiresPause?: boolean }) {
  const { t, timeZone } = useI18n();
  const importNoticeId = useId();
  const toast = useToast();
  const online = useOnline();
  const queries = useQueryClient();
  const salon = useQuery(salonQuery);
  const services = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  const today = localDateOf(new Date().toISOString(), timeZone);
  const maxDate = addDaysLocal(today, salon.data?.maxDaysAhead ?? 60);
  const importBlock =
    imported && imported.requestedDate < today
      ? "waitlist.importedPast"
      : importRequiresPause
        ? "waitlist.importedRequiresPause"
        : null;
  const ownOnly = mode === "admin" && !permissionsFor(role, accessPreset).allCalendars;
  const [selected, setSelected] = useState(imported ? [] : initialServices);
  const [chosenStaff, setChosenStaff] = useState(
    (imported ? unreviewedStaff : initialStaff) ||
      (mode === "admin" && !permissionsFor(role, accessPreset).allCalendars
        ? (ownStaffId ?? "")
        : ""),
  );
  const [fromDate, setFromDate] = useState(imported?.requestedDate ?? initialDate ?? today);
  const [toDate, setToDate] = useState(
    () =>
      imported?.requestedDate ??
      [addDaysLocal(initialDate ?? today, 14), maxDate].sort()[0] ??
      maxDate,
  );
  const [fromTime, setFromTime] = useState(imported ? "" : "09:00");
  const [toTime, setToTime] = useState(imported ? "" : "18:00");
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState(imported?.clientId ?? "");
  const [invalid, setInvalid] = useState(false);
  const key = useRef({ signature: "", id: crypto.randomUUID() });
  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    queryKey: [...waitlistUserKey(mode, viewer.userId), viewer.accessScope, "customers", debounced],
    queryFn: ({ signal }) =>
      api().admin.clients.list(
        { search: debounced, pageSize: 8, sort: "name", order: "asc" },
        signal,
      ),
    enabled: mode === "admin" && !imported && debounced.length > 0,
  });
  const qualified = (staff.data ?? []).filter(
    (s) =>
      selected.every((id) => s.serviceIds.includes(id)) &&
      (mode !== "admin" || permissionsFor(role, accessPreset).allCalendars || s.id === ownStaffId),
  );
  const save = useMutation({
    mutationFn: (input: WaitlistInput & { clientId?: string; importedEntryId?: string }) =>
      api().waitlist.join(mode, input),
    onError: () => {
      if (imported)
        void queries.invalidateQueries({ queryKey: waitlistUserKey(mode, viewer.userId) });
    },
    onSuccess: () => {
      toast.success(t("waitlist.saved"));
      void queries.invalidateQueries({ queryKey: waitlistUserKey(mode, viewer.userId) });
      onJoined();
    },
  });
  if (services.isPending || staff.isPending || salon.isPending)
    return <Skeleton className="h-40" />;
  if (services.isError || staff.isError || salon.isError)
    return (
      <ErrorState
        error={services.error ?? staff.error ?? salon.error}
        onRetry={() => {
          void services.refetch();
          void staff.refetch();
          void salon.refetch();
        }}
      />
    );
  return (
    <form
      aria-label={t("waitlist.new")}
      aria-describedby={imported ? "waitlist-imported-help" : undefined}
      className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (importBlock) return;
        const values = {
          serviceIds: selected,
          staffId: chosenStaff && chosenStaff !== unreviewedStaff ? chosenStaff : null,
          fromDate,
          toDate,
          fromTime,
          toTime,
        };
        const signature = JSON.stringify({ values, clientId });
        if (key.current.signature !== signature)
          key.current = { signature, id: crypto.randomUUID() };
        const input = waitlistInputSchema.safeParse({ ...values, idempotencyKey: key.current.id });
        const valid =
          input.success &&
          (mode !== "admin" || Boolean(clientId)) &&
          fromDate >= today &&
          toDate <= maxDate &&
          selected.every((id) => services.data.some((s) => s.id === id)) &&
          chosenStaff !== unreviewedStaff &&
          (!chosenStaff || qualified.some((s) => s.id === chosenStaff));
        setInvalid(!valid);
        if (input.success && valid)
          save.mutate({
            ...input.data,
            ...(mode === "admin" ? { clientId, importedEntryId: imported?.id } : {}),
          });
      }}
    >
      <UnsavedGuard
        dirty={selected.length > 0 || Boolean(imported ? fromTime || toTime : clientId)}
      />
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
        <h2 className="text-heading">{t("waitlist.new")}</h2>
        <p className="text-sm text-muted">{t("waitlist.help")}</p>
        {imported && (
          <p id="waitlist-imported-help" className="rounded-lg bg-sunken p-3 text-sm">
            {t("waitlist.importedRequest", {
              client: imported.clientName,
              minutes: imported.durationMinutes,
            })}
          </p>
        )}
        {mode === "admin" && !imported && (
          <div className="space-y-3">
            <TextField
              label={t("waitlist.searchClient")}
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setClientId("");
              }}
            />
            {clients.isError && (
              <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
            )}
            <SelectField
              label={t("waitlist.client")}
              value={clientId}
              onChange={setClientId}
              options={[
                { value: "", label: t("waitlist.chooseClient") },
                ...(clients.data?.clients ?? []).map((c) => ({
                  value: c.id,
                  label: `${c.name}${c.email ? ` · ${c.email}` : ""}`,
                })),
              ]}
            />
          </div>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t("waitlist.services")}</legend>
          <CatalogChoices
            allCatalog={services.data}
            catalog={services.data.filter(
              (s) =>
                !ownOnly ||
                staff.data.some((p) => p.id === ownStaffId && p.serviceIds.includes(s.id)),
            )}
            selected={selected}
            maxSelected={8}
            disabled={save.isPending}
            onChange={(next) => {
              setSelected(next);
              const performer = staff.data.find((person) => person.id === chosenStaff);
              if (performer && !next.every((id) => performer.serviceIds.includes(id)))
                setChosenStaff(imported ? unreviewedStaff : "");
            }}
          />
        </fieldset>
        <SelectField
          disabled={ownOnly}
          label={t("waitlist.staff")}
          value={chosenStaff}
          onChange={setChosenStaff}
          options={[
            ...(imported
              ? [
                  {
                    value: unreviewedStaff,
                    label: t("waitlist.importedChooseStaff"),
                    disabled: true,
                  },
                ]
              : []),
            ...(!ownOnly ? [{ value: "", label: t("waitlist.anyStaff") }] : []),
            ...qualified.map((s) => ({ value: s.id, label: s.displayName })),
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("waitlist.fromDate")}
            type="date"
            min={today}
            max={maxDate}
            value={fromDate}
            readOnly={Boolean(imported)}
            onChange={(e) => setFromDate(e.target.value)}
          />
          <TextField
            label={t("waitlist.toDate")}
            type="date"
            min={fromDate}
            max={maxDate}
            value={toDate}
            readOnly={Boolean(imported)}
            onChange={(e) => setToDate(e.target.value)}
          />
          <TextField
            label={t("waitlist.fromTime")}
            type="time"
            step={300}
            value={fromTime}
            name="fromTime"
            required={Boolean(imported)}
            aria-describedby={imported ? "waitlist-imported-help" : undefined}
            onChange={(e) => setFromTime(e.target.value)}
          />
          <TextField
            label={t("waitlist.toTime")}
            type="time"
            step={300}
            value={toTime}
            name="toTime"
            required={Boolean(imported)}
            aria-describedby={imported ? "waitlist-imported-help" : undefined}
            onChange={(e) => setToTime(e.target.value)}
          />
        </div>
        <p className="text-sm text-muted">
          {t("waitlist.timezone", { timezone: salon.data.timezone.replaceAll("_", " ") })}
        </p>
        {invalid && (
          <p role="alert" className="text-danger-fg">
            {t("waitlist.invalid")}
          </p>
        )}
        {save.isError && !importBlock && <ErrorState error={save.error} />}
        {importBlock && (
          <p id={importNoticeId} className="text-sm text-muted">
            {t(importBlock)}
          </p>
        )}
        <Button
          type="submit"
          disabled={!online || Boolean(importBlock)}
          aria-describedby={importBlock ? importNoticeId : undefined}
          loading={save.isPending}
          className="whitespace-normal!"
        >
          {t("waitlist.save")}
        </Button>
      </fieldset>
    </form>
  );
}
