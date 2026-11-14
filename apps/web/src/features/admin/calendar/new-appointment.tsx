import type { Appointment, UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, clientsQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDuration, formatMoney } from "~/lib/format";
import { salonQuery, servicesQuery } from "~/lib/queries";
import { zonedInstant } from "~/lib/zoned";
import { describeProblem } from "../problems";
import { useDebounced } from "../use-debounced";
import {
  buildWalkInRequest,
  validateWalkIn,
  type WalkInErrors,
  type WalkInValues,
} from "./walk-in";

export interface NewAppointmentInitial {
  staffId?: string;
  date: string;
  minutesOfDay?: number;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function NewAppointmentSheet({
  open,
  onOpenChange,
  initial,
  role,
  ownStaffId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: NewAppointmentInitial;
  role: UserRole;
  ownStaffId: string | null;
  onCreated?: (appointment: Appointment) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const salon = useQuery(salonQuery);
  const services = useQuery(servicesQuery);
  const staff = useQuery(adminStaffQuery);
  const granularity = salon.data?.slotGranularityMinutes ?? 15;
  const timeRef = useRef<HTMLInputElement>(null);

  const [values, setValues] = useState<WalkInValues>({
    clientMode: "existing",
    clientId: "",
    newName: "",
    newPhone: "",
    serviceIds: [],
    staffId: initial.staffId ?? ownStaffId ?? "",
    startsAt: "",
    notes: "",
    override: true,
  });
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(hhmm(initial.minutesOfDay ?? 9 * 60));
  const [search, setSearch] = useState("");
  const [pickedName, setPickedName] = useState("");
  const [errors, setErrors] = useState<WalkInErrors>({});
  const [failure, setFailure] = useState<ReturnType<typeof describeProblem> | null>(null);

  // A new slot click reuses the sheet: refill from it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the slot identity resets the form
  useEffect(() => {
    if (!open) return;
    setDate(initial.date);
    setTime(hhmm(initial.minutesOfDay ?? 9 * 60));
    setValues((v) => ({
      ...v,
      staffId: initial.staffId ?? ownStaffId ?? v.staffId,
      serviceIds: [],
    }));
    setErrors({});
    setFailure(null);
  }, [open, initial.date, initial.minutesOfDay, initial.staffId]);

  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    ...clientsQuery({ search: debounced, pageSize: 8, sort: "name", order: "asc" }),
    enabled: values.clientMode === "existing" && debounced.length >= 1,
  });

  const activeStaff = (staff.data ?? []).filter((s) => s.active);
  const chosenStaff = activeStaff.find((s) => s.id === values.staffId);
  const offered = (services.data ?? []).filter((s) => chosenStaff?.serviceIds.includes(s.id));
  const chosen = offered.filter((s) => values.serviceIds.includes(s.id));
  const totalMinutes = chosen.reduce((sum, s) => sum + s.durationMinutes, 0);
  const totalCents = chosen.reduce((sum, s) => sum + s.priceCents, 0);

  const create = useMutation({
    mutationFn: () =>
      api().appointments.create(
        buildWalkInRequest({ ...values, startsAt: zonedInstant(date, time, timeZone) }),
      ),
    onSuccess: (appointment) => {
      toast.success(t("calendar.toast.created"));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      onCreated?.(appointment);
      onOpenChange(false);
    },
    onError: (error) => {
      const problem = describeProblem(error);
      setFailure(problem);
      if (problem.recovery === "pickAnotherTime") timeRef.current?.focus();
      void queryClient.invalidateQueries({ queryKey: ["admin", "calendar"] });
    },
  });

  function submit() {
    const startsAt = date && time ? zonedInstant(date, time, timeZone) : "";
    const found = validateWalkIn({ ...values, startsAt });
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length === 0) create.mutate();
  }

  const set = <K extends keyof WalkInValues>(key: K, value: WalkInValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const errorText = (key: keyof WalkInErrors) =>
    errors[key] ? t(`walkin.error.${key}` as "walkin.error.client") : undefined;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("walkin.title")}
      description={t("walkin.description")}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("admin.cancel")}
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            {t("walkin.submit")}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {failure && (
          <div
            role="alert"
            className="rounded-lg border border-danger-fg/40 bg-danger-soft p-3 text-danger-fg"
          >
            <p className="font-medium">{t(failure.messageKey)}</p>
          </div>
        )}

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium">{t("walkin.client")}</legend>
          <div className="flex gap-2">
            {(["existing", "new"] as const).map((mode) => (
              <label key={mode} className="relative flex-1">
                <input
                  type="radio"
                  name="client-mode"
                  className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0"
                  checked={values.clientMode === mode}
                  onChange={() => set("clientMode", mode)}
                  aria-label={t(
                    mode === "existing" ? "walkin.client.existing" : "walkin.client.new",
                  )}
                />
                <span className="flex min-h-11 items-center justify-center rounded-md border border-line-strong text-sm font-medium peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-soft-fg peer-focus-visible:outline-3 peer-focus-visible:outline-ring">
                  {t(mode === "existing" ? "walkin.client.existing" : "walkin.client.new")}
                </span>
              </label>
            ))}
          </div>

          {values.clientMode === "existing" ? (
            <>
              <TextField
                label={t("walkin.client.search")}
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  set("clientId", "");
                }}
                error={errorText("client")}
                autoComplete="off"
              />
              {values.clientId && (
                <p className="text-sm font-medium text-success-fg">
                  {t("walkin.client.selected", { name: pickedName })}
                </p>
              )}
              {debounced.length >= 1 && clients.data && (
                <fieldset className="space-y-1">
                  <legend className="sr-only">{t("walkin.client.results")}</legend>
                  {clients.data.clients.length === 0 && (
                    <p className="text-sm text-muted">{t("walkin.client.none")}</p>
                  )}
                  {clients.data.clients.map((client) => (
                    <label
                      key={client.id}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 hover:bg-sunken has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                    >
                      <input
                        type="radio"
                        name="client"
                        checked={values.clientId === client.id}
                        onChange={() => {
                          set("clientId", client.id);
                          setPickedName(client.name);
                        }}
                      />
                      <span>
                        <span className="font-medium">{client.name}</span>
                        {client.phone && (
                          <span className="ml-2 text-sm text-muted">{client.phone}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          ) : (
            <>
              <TextField
                label={t("walkin.client.name")}
                value={values.newName}
                onChange={(e) => set("newName", e.target.value)}
                error={errorText("client")}
                autoComplete="off"
              />
              <TextField
                label={t("walkin.client.phone")}
                type="tel"
                value={values.newPhone}
                onChange={(e) => set("newPhone", e.target.value)}
                error={errorText("phone")}
                autoComplete="off"
              />
            </>
          )}
        </fieldset>

        <SelectField
          label={t("walkin.staff")}
          value={values.staffId}
          disabled={role === "staff"}
          options={[
            { value: "", label: "-", disabled: true },
            ...activeStaff.map((s) => ({ value: s.id, label: s.displayName })),
          ]}
          onChange={(value) => setValues((v) => ({ ...v, staffId: value, serviceIds: [] }))}
          error={errorText("staff")}
        />

        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">{t("walkin.services")}</legend>
          {chosenStaff && offered.length === 0 && (
            <p className="text-sm text-muted">{t("walkin.services.none")}</p>
          )}
          {offered.map((service) => (
            <label
              key={service.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 hover:bg-sunken has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="checkbox"
                className="size-5 accent-[var(--accent)]"
                checked={values.serviceIds.includes(service.id)}
                onChange={(e) =>
                  set(
                    "serviceIds",
                    e.target.checked
                      ? [...values.serviceIds, service.id]
                      : values.serviceIds.filter((id) => id !== service.id),
                  )
                }
              />
              <span className="flex-1">
                <span className="font-medium">{service.name}</span>
                <span className="ml-2 text-sm text-muted">
                  {formatDuration(service.durationMinutes, locale)} ·{" "}
                  {formatMoney(service.priceCents, service.currency, locale)}
                </span>
              </span>
            </label>
          ))}
          {errors.services && (
            <p role="alert" className="text-sm font-medium text-danger-fg">
              {errorText("services")}
            </p>
          )}
          {chosen.length > 0 && (
            <p className="pt-1 text-sm text-muted">
              {t("walkin.total", {
                duration: formatDuration(totalMinutes, locale),
                price: formatMoney(totalCents, chosen[0]?.currency ?? "ARS", locale),
              })}
            </p>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("walkin.date")}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            error={errors.time ? errorText("time") : undefined}
          />
          <TextField
            ref={timeRef}
            label={t("walkin.time")}
            type="time"
            step={granularity * 60}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            hint={t("walkin.timeHint", {
              timezone: timeZone.replaceAll("_", " "),
              minutes: granularity,
            })}
          />
        </div>

        <TextAreaField
          label={t("walkin.notes")}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
        />

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-5 accent-[var(--accent)]"
            checked={values.override}
            onChange={(e) => set("override", e.target.checked)}
          />
          <span>
            <span className="font-medium">{t("walkin.override")}</span>
            <span className="block text-sm text-muted">{t("walkin.override.hint")}</span>
          </span>
        </label>
      </form>
    </Sheet>
  );
}
