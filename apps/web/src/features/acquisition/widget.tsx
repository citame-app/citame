import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { normalizeCatalogSelection } from "~/features/booking/catalog-selection";
import { eligibleStaff } from "~/features/booking/logic";
import type { Locale } from "~/i18n";
import { I18nProvider, useI18n } from "~/i18n/react";
import { servicesQuery, staffQuery } from "~/lib/queries";
import type { BookingEntrySelection } from "./links";

export function BookingWidget(props: {
  salonName: string;
  onlineBookingEnabled?: boolean;
  initialSelection: BookingEntrySelection;
}) {
  const initial = useI18n();
  const [locale, setLocale] = useState<Locale>(initial.locale);
  return (
    <I18nProvider locale={locale} timeZone={initial.timeZone}>
      <WidgetBody {...props} locale={locale} onLocaleChange={setLocale} />
    </I18nProvider>
  );
}
function WidgetBody({
  salonName,
  onlineBookingEnabled = true,
  initialSelection,
  locale,
  onLocaleChange,
}: {
  salonName: string;
  onlineBookingEnabled?: boolean;
  initialSelection: BookingEntrySelection;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  const services = useQuery({ ...servicesQuery, enabled: onlineBookingEnabled });
  const staff = useQuery({ ...staffQuery, enabled: onlineBookingEnabled });
  const [selected, setSelected] = useState(initialSelection.serviceIds);
  const [staffId, setStaffId] = useState(initialSelection.staffId ?? "");
  const ids = normalizeCatalogSelection(selected, services.data ?? [], 24);
  const eligible = eligibleStaff(staff.data ?? [], ids);
  const selectedStaff = staffId && eligible.some((person) => person.id === staffId) ? staffId : "";
  const ready = !!services.data && !!staff.data && !services.isError && !staff.isError;
  const noProfessional = ids.length > 0 && eligible.length === 0;
  const params = new URLSearchParams();
  if (ids.length) params.set("services", ids.join(","));
  if (selectedStaff) params.set("staff", selectedStaff);
  const href = `/book${params.size ? `?${params}` : ""}`;
  return (
    <div lang={locale} className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center font-display text-lg font-semibold text-accent-text"
        >
          {salonName}
        </a>
        <div className="min-w-36">
          <SelectField
            label={t("widget.language")}
            value={locale}
            options={[
              { value: "en", label: "English" },
              { value: "es-AR", label: "Español" },
            ]}
            onChange={(value) => onLocaleChange(value === "es-AR" ? "es-AR" : "en")}
          />
        </div>
      </div>
      <h1 className="text-title">
        {onlineBookingEnabled ? t("widget.title", { name: salonName }) : t("booking.paused.title")}
      </h1>
      <p className="text-muted">
        {t(onlineBookingEnabled ? "widget.lead" : "booking.paused.body")}
      </p>
      {onlineBookingEnabled && (services.isPending || staff.isPending) && (
        <Skeleton className="h-40" />
      )}
      {services.isError && (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      )}
      {staff.isError && <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />}
      {onlineBookingEnabled && ready && services.data?.length === 0 && (
        <EmptyState title={t("widget.empty")} />
      )}
      {onlineBookingEnabled && ready && (
        <>
          <CatalogChoices
            catalog={services.data ?? []}
            selected={ids}
            onChange={(value) => {
              setSelected(value);
              setStaffId("");
            }}
          />
          <SelectField
            label={t("acquisition.staff")}
            value={selectedStaff}
            options={[
              { value: "", label: t("acquisition.any") },
              ...eligible.map((person) => ({ value: person.id, label: person.displayName })),
            ]}
            onChange={setStaffId}
          />
          {selected.length !== ids.length && (
            <p role="status" className="text-sm text-muted">
              {t("acquisition.invalidSelection")}
            </p>
          )}
          {noProfessional ? (
            <p role="status" className="text-muted">
              {t("acquisition.noProfessional")}
            </p>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ size: "lg" })}
            >
              {t(ids.length ? "widget.continue" : "widget.all")}
            </a>
          )}
        </>
      )}
    </div>
  );
}
