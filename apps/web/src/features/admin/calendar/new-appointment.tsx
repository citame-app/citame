import {
  type Appointment,
  type AppointmentSeriesInput,
  type AppointmentSeriesPreview,
  permissionsFor,
  type StaffAccessPreset,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { useToast } from "~/components/ui/toast";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, clientsQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatDuration, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { salonQuery, servicesQuery } from "~/lib/queries";
import { minutesIntoLocalDay, zonedInstant } from "~/lib/zoned";
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
  accessPreset,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: NewAppointmentInitial;
  role: UserRole;
  ownStaffId: string | null;
  accessPreset?: StaffAccessPreset | null;
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
  const [waiver, setWaiver] = useState("");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(hhmm(initial.minutesOfDay ?? 9 * 60));
  const [search, setSearch] = useState("");
  const [pickedName, setPickedName] = useState("");
  const [errors, setErrors] = useState<WalkInErrors>({});
  const [failure, setFailure] = useState<ReturnType<typeof describeProblem> | null>(null);
  const [cadence, setCadence] = useState<"none" | "weekly" | "monthly">("none");
  const [interval, setInterval] = useState("1");
  const [count, setCount] = useState("3");
  const [seriesError, setSeriesError] = useState(false);
  const [review, setReview] = useState<{
    signature: string;
    input: AppointmentSeriesInput;
    data: AppointmentSeriesPreview;
    key: string;
  } | null>(null);
  function resolveStart(): string {
    if (!date || !time) return "";
    try {
      const value = zonedInstant(date, time, timeZone);
      const [hour = "", minute = ""] = time.split(":");
      if (
        localDateOf(value, timeZone) !== date ||
        minutesIntoLocalDay(value, timeZone) !== Number(hour) * 60 + Number(minute)
      )
        return "";
      return value;
    } catch {
      return "";
    }
  }
  const signature = JSON.stringify({
    values,
    date,
    time,
    waiver,
    cadence,
    interval,
    count,
    timeZone,
  });
  const reviewed = review?.signature === signature ? review : null;

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
    setWaiver("");
    setCadence("none");
    setInterval("1");
    setCount("3");
    setReview(null);
    setSeriesError(false);
  }, [open, initial.date, initial.minutesOfDay, initial.staffId]);

  const debounced = useDebounced(search.trim());
  const clients = useQuery({
    ...clientsQuery({ search: debounced, pageSize: 8, sort: "name", order: "asc" }),
    enabled: values.clientMode === "existing" && debounced.length >= 1,
  });

  const activeStaff = (staff.data ?? []).filter((s) => s.active);
  const chosenStaff = activeStaff.find((s) => s.id === values.staffId);
  const offered = (services.data ?? []).filter((s) => chosenStaff?.serviceIds.includes(s.id));
  const chosen = values.serviceIds.flatMap((id) => {
    const s = offered.find((s) => s.id === id);
    return s ? [s] : [];
  });
  const totalMinutes = chosen.reduce((sum, s) => sum + s.durationMinutes, 0);
  const totalCents = chosen.reduce((sum, s) => sum + s.priceCents, 0);

  const preview = useMutation({
    mutationFn: async (request: { signature: string; input: AppointmentSeriesInput }) => ({
      ...request,
      data: await api().appointmentSeries.preview(request.input),
      key: review?.signature === request.signature ? review.key : crypto.randomUUID(),
    }),
    onSuccess: setReview,
    onError: (error) => setFailure(describeProblem(error)),
  });
  const create = useMutation({
    mutationFn: async () => {
      if (cadence !== "none") {
        if (!reviewed) throw new Error("Review the recurring visits first");
        const series = await api().appointmentSeries.create({
          ...reviewed.input,
          reviewHash: reviewed.data.reviewHash,
          idempotencyKey: reviewed.key,
        });
        const first = series.appointments[0];
        if (!first) throw new Error("The series has no appointments");
        return first;
      }
      return api().appointments.create({
        ...buildWalkInRequest({ ...values, startsAt: resolveStart() }),
        ...(waiver.trim() ? { protectionWaiverReason: waiver.trim() } : {}),
      });
    },
    onSuccess: (appointment) => {
      toast.success(
        cadence === "none"
          ? t("calendar.toast.created")
          : t("series.created", { count: Number(count) }),
      );
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      onCreated?.(appointment);
      onOpenChange(false);
    },
    onError: (error) => {
      const problem = describeProblem(error);
      setFailure(problem);
      if (
        cadence !== "none" &&
        (problem.recovery === "reload" || problem.recovery === "pickAnotherTime")
      )
        setReview(null);
      if (problem.recovery === "pickAnotherTime") timeRef.current?.focus();
      void queryClient.invalidateQueries({ queryKey: ["admin", "calendar"] });
    },
  });

  function submit() {
    const startsAt = resolveStart();
    const found = validateWalkIn({ ...values, startsAt });
    setErrors(found);
    setFailure(null);
    const validSeries =
      Number.isInteger(Number(interval)) &&
      Number(interval) >= 1 &&
      Number(interval) <= 12 &&
      Number.isInteger(Number(count)) &&
      Number(count) >= 2 &&
      Number(count) <= 12;
    setSeriesError(cadence !== "none" && !validSeries);
    if (Object.keys(found).length !== 0 || (cadence !== "none" && !validSeries)) return;
    if (cadence !== "none" && !reviewed) {
      const { id: _id, ...booking } = buildWalkInRequest({ ...values, startsAt });
      preview.mutate({
        signature,
        input: {
          ...booking,
          cadence,
          interval: Number(interval),
          count: Number(count),
          ...(waiver.trim() ? { protectionWaiverReason: waiver.trim() } : {}),
        },
      });
    } else create.mutate();
  }

  // After a failed submit, keep the messages in step with what the form holds now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only edits re-run validation
  useEffect(() => {
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      const startsAt = resolveStart();
      return validateWalkIn({ ...values, startsAt });
    });
  }, [values, date, time]);

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
          <Button
            loading={create.isPending || preview.isPending}
            disabled={Boolean(reviewed?.data.occurrences.some((o) => !o.available))}
            onClick={submit}
          >
            {cadence === "none"
              ? t("walkin.submit")
              : reviewed
                ? t("series.confirm", { count: Number(count) })
                : t("series.review")}
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

        {permissionsFor(role, accessPreset).refunds && (
          <TextField
            label={t("protection.waiver")}
            value={waiver}
            maxLength={300}
            hint={t("protection.waiverHelp")}
            onChange={(e) => setWaiver(e.target.value)}
          />
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
          disabled={role === "staff" && !permissionsFor(role, accessPreset).allCalendars}
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
          <CatalogChoices
            catalog={offered}
            allCatalog={services.data ?? []}
            selected={values.serviceIds}
            onChange={(ids) => set("serviceIds", ids)}
            disabled={create.isPending}
          />
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

        <fieldset className="min-w-0 space-y-4 rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-medium">{t("series.repeat")}</legend>
          <SelectField
            label={t("series.repeat")}
            value={cadence}
            onChange={(v) => setCadence(v as typeof cadence)}
            options={[
              { value: "none", label: t("series.none") },
              { value: "weekly", label: t("series.weekly") },
              { value: "monthly", label: t("series.monthly") },
            ]}
          />
          {cadence !== "none" && (
            <>
              <p className="text-sm text-muted">{t("series.help")}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label={t("series.interval")}
                  hint={t(cadence === "weekly" ? "series.intervalWeeks" : "series.intervalMonths")}
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                />
                <TextField
                  label={t("series.count")}
                  type="number"
                  min={2}
                  max={12}
                  step={1}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </div>
              {seriesError && (
                <p role="alert" className="text-sm text-danger-fg">
                  {t("series.validation")}
                </p>
              )}
              {reviewed && (
                <section aria-label={t("series.dates")} className="space-y-3" aria-live="polite">
                  <p className="text-sm font-medium">
                    {t("series.price", {
                      price: formatMoney(
                        reviewed.data.perVisitCents,
                        reviewed.data.currency,
                        locale,
                      ),
                    })}
                  </p>
                  <ol className="space-y-2">
                    {reviewed.data.occurrences.map((o) => (
                      <li key={o.startsAt} className="rounded-md bg-sunken p-3 text-sm">
                        <p>
                          {formatDateLong(localDateOf(o.startsAt, reviewed.data.timezone), locale)}{" "}
                          · {formatTime(o.startsAt, reviewed.data.timezone, locale)}
                        </p>
                        <p className={o.available ? "text-success-fg" : "text-danger-fg"}>
                          {t(o.available ? "series.available" : "series.unavailable")}
                        </p>
                      </li>
                    ))}
                  </ol>
                  <Button
                    variant="secondary"
                    loading={preview.isPending}
                    disabled={create.isPending}
                    onClick={() => preview.mutate({ signature, input: reviewed.input })}
                  >
                    {t("series.refresh")}
                  </Button>
                </section>
              )}
            </>
          )}
        </fieldset>

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
