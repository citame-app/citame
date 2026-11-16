import {
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
  type WaitlistInput,
  waitlistInputSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useDebounced } from "~/features/admin/use-debounced";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { addDaysLocal, formatMoney, localDateOf } from "~/lib/format";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
export interface JoinFormProps {
  mode: CommerceMode;
  role: UserRole;
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
  initialServices = [],
  initialStaff,
  initialDate,
  onJoined,
}: JoinFormProps) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const queries = useQueryClient();
  const salon = useQuery(salonQuery);
  const services = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  const today = localDateOf(new Date().toISOString(), timeZone);
  const maxDate = addDaysLocal(today, salon.data?.maxDaysAhead ?? 60);
  const ownOnly = mode === "admin" && !permissionsFor(role, accessPreset).allCalendars;
  const [selected, setSelected] = useState(initialServices);
  const [chosenStaff, setChosenStaff] = useState(
    initialStaff ??
      (mode === "admin" && !permissionsFor(role, accessPreset).allCalendars
        ? (ownStaffId ?? "")
        : ""),
  );
  const [fromDate, setFromDate] = useState(initialDate ?? today);
  const [toDate, setToDate] = useState(
    () => [addDaysLocal(initialDate ?? today, 14), maxDate].sort()[0] ?? maxDate,
  );
  const [fromTime, setFromTime] = useState("09:00");
  const [toTime, setToTime] = useState("18:00");
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [invalid, setInvalid] = useState(false);
  const key = useRef({ signature: "", id: crypto.randomUUID() });
  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    queryKey: ["waitlist", "customers", debounced],
    queryFn: () =>
      api().admin.clients.list({ search: debounced, pageSize: 8, sort: "name", order: "asc" }),
    enabled: mode === "admin" && debounced.length > 0,
  });
  const qualified = (staff.data ?? []).filter(
    (s) =>
      selected.every((id) => s.serviceIds.includes(id)) &&
      (mode !== "admin" || permissionsFor(role, accessPreset).allCalendars || s.id === ownStaffId),
  );
  const save = useMutation({
    mutationFn: (input: WaitlistInput & { clientId?: string }) => api().waitlist.join(mode, input),
    onSuccess: () => {
      toast.success(t("waitlist.saved"));
      void queries.invalidateQueries({ queryKey: ["waitlist"] });
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
      className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const values = {
          serviceIds: selected,
          staffId: chosenStaff || null,
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
          (!chosenStaff || qualified.some((s) => s.id === chosenStaff));
        setInvalid(!valid);
        if (input.success && valid)
          save.mutate({ ...input.data, ...(mode === "admin" ? { clientId } : {}) });
      }}
    >
      <UnsavedGuard dirty={selected.length > 0 || Boolean(clientId)} />
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
        <h2 className="text-heading">{t("waitlist.new")}</h2>
        <p className="text-sm text-muted">{t("waitlist.help")}</p>
        {mode === "admin" && (
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
          {services.data
            .filter(
              (s) =>
                !ownOnly ||
                staff.data.some(
                  (person) => person.id === ownStaffId && person.serviceIds.includes(s.id),
                ),
            )
            .map((s) => (
              <label
                key={s.id}
                className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-line p-3"
              >
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-accent"
                  checked={selected.includes(s.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, s.id]
                      : selected.filter((id) => id !== s.id);
                    setSelected(next);
                    const performer = staff.data.find((person) => person.id === chosenStaff);
                    if (performer && !next.every((id) => performer.serviceIds.includes(id)))
                      setChosenStaff("");
                  }}
                />
                <span className="min-w-0 break-words">
                  {s.name} · {formatMoney(s.priceCents, s.currency, locale)}
                </span>
              </label>
            ))}
        </fieldset>
        <SelectField
          disabled={ownOnly}
          label={t("waitlist.staff")}
          value={chosenStaff}
          onChange={setChosenStaff}
          options={[
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
            onChange={(e) => setFromDate(e.target.value)}
          />
          <TextField
            label={t("waitlist.toDate")}
            type="date"
            min={fromDate}
            max={maxDate}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
          <TextField
            label={t("waitlist.fromTime")}
            type="time"
            step={300}
            value={fromTime}
            onChange={(e) => setFromTime(e.target.value)}
          />
          <TextField
            label={t("waitlist.toTime")}
            type="time"
            step={300}
            value={toTime}
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
        {save.isError && <ErrorState error={save.error} />}
        <Button
          type="submit"
          disabled={!online}
          loading={save.isPending}
          className="whitespace-normal!"
        >
          {t("waitlist.save")}
        </Button>
      </fieldset>
    </form>
  );
}
