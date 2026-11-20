import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { normalizeCatalogSelection } from "~/features/booking/catalog-selection";
import { eligibleStaff } from "~/features/booking/logic";
import { useI18n } from "~/i18n/react";
import { servicesQuery, staffQuery } from "~/lib/queries";
import { bookingEntryUrl, bookingWidgetSnippet, bookingWidgetUrl } from "./links";
import { generateBookingQr } from "./qr";

export function BookingLinks({
  salonName,
  origin,
  makeQr = generateBookingQr,
}: {
  salonName: string;
  origin?: string;
  makeQr?: (url: string) => Promise<string>;
}) {
  const { t } = useI18n();
  const services = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  const [siteOrigin, setOrigin] = useState(origin ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [staffId, setStaffId] = useState("");
  const [qr, setQr] = useState<{ url: string; image: string }>();
  const [qrError, setQrError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [feedback, setFeedback] = useState<"copied" | "error">();
  const [shareSupported, setShareSupported] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    setOrigin(origin ?? window.location.origin);
    setShareSupported(typeof navigator.share === "function");
  }, [origin]);
  const ids = normalizeCatalogSelection(selected, services.data ?? [], 24);
  const eligible = eligibleStaff(staff.data ?? [], ids);
  const validStaff =
    staffId && eligible.some((person) => person.id === staffId) ? staffId : undefined;
  const unavailable = selected.length !== ids.length || Boolean(staffId && !validStaff);
  const noProfessional = ids.length > 0 && eligible.length === 0;
  const selection = { serviceIds: ids, ...(validStaff ? { staffId: validStaff } : {}) };
  const url = siteOrigin ? bookingEntryUrl(siteOrigin, selection) : "";
  const widgetUrl = siteOrigin ? bookingWidgetUrl(siteOrigin, selection) : "";
  const snippet = siteOrigin ? bookingWidgetSnippet(siteOrigin, selection, salonName) : "";
  const ready =
    !!services.data &&
    !!staff.data &&
    !services.isError &&
    !staff.isError &&
    !unavailable &&
    !noProfessional;
  const qrSource = ready ? url : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly requests another render after a failed QR job.
  useEffect(() => {
    if (!qrSource) return;
    let active = true;
    setQrError(false);
    void makeQr(qrSource)
      .then((image) => {
        if (active) setQr({ url: qrSource, image });
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [qrSource, makeQr, retry]);
  const currentQr = qr?.url === qrSource && !qrError ? qr.image : undefined;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("copied");
    } catch {
      setFeedback("error");
    }
  };
  const choices = [
    { value: "", label: t("acquisition.any") },
    ...eligible.map((person) => ({ value: person.id, label: person.displayName })),
  ];
  return (
    <section aria-label={t("acquisition.title")} className="space-y-6">
      <p className="max-w-prose text-muted">{t("acquisition.lead")}</p>
      {services.isPending || staff.isPending ? <Skeleton className="h-32" /> : null}
      {services.isError && (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      )}
      {staff.isError && <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />}
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <div className="space-y-5">
          <h2 className="text-heading">{t("acquisition.services")}</h2>
          <CatalogChoices
            catalog={services.data ?? []}
            selected={ids}
            onChange={(value) => {
              setSelected(value);
              if (!value.length) setStaffId("");
              setFeedback(undefined);
            }}
          />
          <SelectField
            label={t("acquisition.staff")}
            value={validStaff ?? ""}
            options={choices}
            disabled={ids.length === 0}
            hint={ids.length === 0 ? t("acquisition.selectServicesFirst") : undefined}
            onChange={(value) => {
              setStaffId(value);
              setFeedback(undefined);
            }}
          />
          {(selected.length > 0 || staffId) && (
            <Button
              variant="ghost"
              onClick={() => {
                setSelected([]);
                setStaffId("");
                setFeedback(undefined);
              }}
            >
              {t("acquisition.clear")}
            </Button>
          )}
          {unavailable && (
            <p role="status" className="text-muted">
              {t("acquisition.invalidSelection")}
            </p>
          )}
          {noProfessional && (
            <p role="status" className="text-muted">
              {t("acquisition.noProfessional")}
            </p>
          )}
        </div>
        <div className="space-y-5 rounded-xl border border-line bg-surface p-5">
          <TextField label={t("acquisition.link")} value={url} readOnly />
          <div className="flex flex-wrap gap-3">
            <Button disabled={!ready || !url} onClick={() => void copy(url)}>
              {t("acquisition.copy")}
            </Button>
            {ready && url && (
              <>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({ variant: "secondary" })}
                >
                  {t("acquisition.preview")}
                </a>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(url)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({ variant: "secondary" })}
                >
                  {t("acquisition.shareWhatsapp")}
                </a>
                <a
                  href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({ variant: "secondary" })}
                >
                  {t("acquisition.shareFacebook")}
                </a>
              </>
            )}
            {shareSupported && (
              <Button
                variant="secondary"
                disabled={!ready || !url}
                onClick={() => {
                  void navigator.share({ title: salonName, url }).catch((error) => {
                    if (!(error instanceof DOMException && error.name === "AbortError"))
                      setFeedback("error");
                  });
                }}
              >
                {t("acquisition.share")}
              </Button>
            )}
          </div>
          {feedback && (
            <p role="status" className="text-sm text-muted">
              {t(feedback === "copied" ? "acquisition.copied" : "acquisition.copyError")}
            </p>
          )}
          {currentQr ? (
            <>
              <img
                src={currentQr}
                alt={t("acquisition.qr")}
                width={256}
                height={256}
                className="mx-auto size-64 max-w-full rounded-lg"
              />
              <a
                href={currentQr}
                download="sisters-booking-qr.png"
                className={buttonClasses({ variant: "secondary" })}
              >
                {t("acquisition.downloadQr")}
              </a>
            </>
          ) : qrError ? (
            <div role="alert">
              <p className="text-danger-fg">{t("acquisition.qrError")}</p>
              <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <Skeleton className="mx-auto size-64 max-w-full" />
          )}
          <p className="text-sm text-muted">{t("acquisition.qrHelp")}</p>
          <div className="space-y-4 border-t border-line pt-5">
            <h2 className="text-heading">{t("acquisition.widget")}</h2>
            <p className="text-sm text-muted">{t("acquisition.widgetHelp")}</p>
            <TextAreaField label={t("acquisition.snippet")} value={snippet} readOnly rows={5} />
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                disabled={!ready || !snippet}
                onClick={() => void copy(snippet)}
              >
                {t("acquisition.copySnippet")}
              </Button>
              <Button
                variant="ghost"
                disabled={!ready || !widgetUrl}
                onClick={() => setPreview((value) => !value)}
              >
                {t("acquisition.widgetPreview")}
              </Button>
            </div>
            {preview && ready && (
              <iframe
                src={widgetUrl}
                title={t("acquisition.widgetPreview")}
                className="h-[36rem] w-full rounded-lg border border-line"
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
