import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { priceLabel } from "~/features/booking/service-price";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDuration } from "~/lib/format";
import { servicesQuery, staffQuery } from "~/lib/queries";
import { CreativeOverflowError } from "./creative-layout";
import {
  type CreativeSource,
  CreativeSourceError,
  creativeModel,
  creativeSourceSignature,
} from "./creative-model";
import {
  type CreativeFormat,
  type CreativePalette,
  type CreativeRenderer,
  type PreparedCreative,
  renderCreative,
} from "./creative-renderer";

class CreativeStaleError extends Error {}
type Preview = PreparedCreative & { source: CreativeSource; signature: string };

export function SocialCreative({
  salonName,
  origin,
  renderer = renderCreative,
}: {
  salonName: string;
  origin?: string;
  renderer?: CreativeRenderer;
}) {
  const { t, locale, timeZone } = useI18n();
  const client = useQueryClient();
  const services = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  const [kind, setKind] = useState<CreativeSource["kind"]>("service");
  const [serviceId, setServiceId] = useState("");
  const [promotionId, setPromotionId] = useState("");
  const [reviewId, setReviewId] = useState("");
  const [promotionPage, setPromotionPage] = useState(1);
  const [promotionSearch, setPromotionSearch] = useState("");
  const [reviewBefore, setReviewBefore] = useState<string>();
  const [format, setFormat] = useState<CreativeFormat>("portrait");
  const [palette, setPalette] = useState<CreativePalette>("cream");
  const [siteOrigin, setOrigin] = useState(origin ?? "");
  const [preview, setPreview] = useState<Preview>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [feedback, setFeedback] = useState<"copied" | "copyError" | "download">();
  const activity = useRef({ generation: 0, mounted: true });
  useEffect(() => {
    setOrigin(origin ?? window.location.origin);
  }, [origin]);
  useEffect(() => {
    const current = activity.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      current.generation++;
    };
  }, []);
  const promotions = useQuery({
    queryKey: ["creative", "promotions", promotionPage, promotionSearch],
    queryFn: () => api().rewards.promotions(promotionPage, promotionSearch),
    enabled: kind === "promotion",
    gcTime: 0,
  });
  const reviews = useQuery({
    queryKey: ["creative", "reviews", reviewBefore],
    queryFn: () => api().reviews.admin({ status: "published", before: reviewBefore }),
    enabled: kind === "review",
    gcTime: 0,
  });
  const service = services.data?.find((row) => row.id === serviceId);
  const promotion = promotions.data?.promotions.find((row) => row.id === promotionId);
  const review = reviews.data?.reviews.find((row) => row.id === reviewId);
  const publicServices = (services.data ?? []).filter(
    (row) =>
      row.catalog?.kind !== "addon" &&
      (staff.data ?? []).some((person) => person.serviceIds.includes(row.id)),
  );
  const hasService = Boolean(service && publicServices.some((row) => row.id === service.id));
  let snapshot: CreativeSource | undefined;
  if (kind === "service" && service) snapshot = { kind, service };
  if (kind === "promotion" && service && promotion) snapshot = { kind, service, promotion };
  let eligible =
    kind === "review"
      ? Boolean(review?.allowSocialUse && review.sourceEligible && review.status === "published")
      : Boolean(snapshot && hasService);
  if (snapshot) {
    try {
      creativeModel(snapshot, { locale, timeZone, now: new Date() });
    } catch {
      eligible = false;
    }
  }
  const sourceReady =
    eligible &&
    !!siteOrigin &&
    !services.isError &&
    (kind === "review"
      ? !reviews.isError
      : !staff.isError && (kind !== "promotion" || !promotions.isError));
  const sourceKey = snapshot
    ? creativeSourceSignature(snapshot)
    : JSON.stringify([reviewId, review?.version]);
  const optionsKey = JSON.stringify([
    kind,
    sourceKey,
    format,
    palette,
    locale,
    timeZone,
    siteOrigin,
    sourceReady,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed source/options tuple invalidates the reviewed preview and pending render.
  useEffect(() => {
    activity.current.generation++;
    setPreview(undefined);
    setReviewed(false);
    setError(undefined);
    setFeedback(undefined);
    setBusy(false);
  }, [optionsKey]);

  async function freshSource(expected?: CreativeSource): Promise<CreativeSource> {
    let fresh: CreativeSource;
    if (kind === "review") {
      const current = await api().reviews.social(reviewId);
      if (!expected && current.reviewVersion !== review?.version) throw new CreativeStaleError();
      fresh = { kind, review: current };
    } else {
      const [catalog, performers] = await Promise.all([api().services(true), api().staff(true)]);
      const current = catalog.services.find((row) => row.id === serviceId);
      if (!current || !performers.staff.some((person) => person.serviceIds.includes(serviceId)))
        throw new CreativeStaleError();
      if (kind === "promotion") {
        const directory = await api().rewards.promotions(promotionPage, promotionSearch, true);
        const offer = directory.promotions.find((row) => row.id === promotionId);
        if (!offer) throw new CreativeStaleError();
        fresh = { kind, service: current, promotion: offer };
      } else fresh = { kind, service: current };
    }
    creativeModel(fresh, { locale, timeZone, now: new Date() });
    const previous = expected ?? snapshot;
    if (previous && creativeSourceSignature(previous) !== creativeSourceSignature(fresh))
      throw new CreativeStaleError();
    return fresh;
  }
  function failed(reason: unknown) {
    setError(reason);
    setPreview(undefined);
    setReviewed(false);
  }
  async function prepare() {
    const current = activity.current;
    const ticket = ++current.generation;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    setReviewed(false);
    try {
      const source = await freshSource();
      const image = await renderer({
        source,
        salonName,
        locale,
        timeZone,
        origin: siteOrigin,
        format,
        palette,
      });
      if (current.mounted && current.generation === ticket)
        setPreview({ ...image, source, signature: creativeSourceSignature(source) });
    } catch (reason) {
      if (current.mounted && current.generation === ticket) failed(reason);
    } finally {
      if (current.mounted && current.generation === ticket) setBusy(false);
    }
  }
  async function exportContent(action: "png" | "caption" | "copy") {
    if (!preview || !reviewed) return;
    const current = activity.current;
    const ticket = ++current.generation;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    let clipboardAttempted = false;
    try {
      const source = await freshSource(preview.source);
      if (!current.mounted || current.generation !== ticket) return;
      if (creativeSourceSignature(source) !== preview.signature) throw new CreativeStaleError();
      if (action === "copy") {
        clipboardAttempted = true;
        await navigator.clipboard.writeText(preview.caption);
        if (current.mounted && current.generation === ticket) setFeedback("copied");
      } else {
        const url =
          action === "png"
            ? preview.dataUrl
            : URL.createObjectURL(
                new Blob([preview.caption], { type: "text/plain;charset=utf-8" }),
              );
        const link = document.createElement("a");
        link.href = url;
        link.download = `sisters-${kind}-${format}-${locale}.${action === "png" ? "png" : "txt"}`;
        link.click();
        if (action === "caption") window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setFeedback("download");
      }
    } catch (reason) {
      if (current.mounted && current.generation === ticket) {
        if (
          action === "copy" &&
          clipboardAttempted &&
          !(reason instanceof ApiError) &&
          !(reason instanceof CreativeStaleError) &&
          !(reason instanceof CreativeSourceError)
        )
          setFeedback("copyError");
        else failed(reason);
      }
    } finally {
      if (current.mounted && current.generation === ticket) setBusy(false);
    }
  }
  const errorText =
    error instanceof CreativeOverflowError
      ? t("social.overflow")
      : error instanceof CreativeStaleError || (error instanceof ApiError && error.status === 404)
        ? t("social.changed")
        : error instanceof CreativeSourceError
          ? t("social.unavailable")
          : t("social.failed");
  const reload = () => {
    setError(undefined);
    setPreview(undefined);
    setReviewed(false);
    void client.invalidateQueries({ queryKey: ["creative"] });
    void client.invalidateQueries({ queryKey: ["services"] });
    void client.invalidateQueries({ queryKey: ["staff"] });
  };
  return (
    <section aria-label={t("social.title")} aria-busy={busy} className="space-y-6">
      <p className="max-w-prose text-muted">{t("social.lead")}</p>
      <p className="max-w-prose text-sm text-muted">{t("social.reviewHelp")}</p>
      {services.isPending && <Skeleton className="h-20" />}
      {services.isError && <ErrorState error={services.error} onRetry={reload} />}
      {staff.isError && kind !== "review" && <ErrorState error={staff.error} onRetry={reload} />}
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <SelectField
            label={t("social.template")}
            value={kind}
            disabled={busy}
            options={(["service", "promotion", "review"] as const).map((value) => ({
              value,
              label: t(`social.${value}`),
            }))}
            onChange={(value) =>
              setKind(
                value === "promotion" ? "promotion" : value === "review" ? "review" : "service",
              )
            }
          />
          {kind !== "review" && (
            <SelectField
              label={t("social.chooseService")}
              value={serviceId}
              disabled={busy || services.isPending || staff.isPending}
              options={[
                { value: "", label: t("social.chooseService") },
                ...publicServices.map((row) => ({ value: row.id, label: row.name })),
              ]}
              onChange={setServiceId}
            />
          )}
          {kind !== "review" && service && (
            <p className="text-sm text-muted">
              {t("social.serviceDetails", {
                price: priceLabel(t, locale, service),
                duration: formatDuration(service.durationMinutes, locale),
              })}
            </p>
          )}
          {kind === "promotion" && (
            <>
              <TextField
                label={t("social.searchPromotion")}
                value={promotionSearch}
                maxLength={100}
                disabled={busy}
                onChange={(event) => {
                  setPromotionSearch(event.target.value);
                  setPromotionPage(1);
                  setPromotionId("");
                }}
              />
              {promotions.isPending && <Skeleton className="h-12" />}
              {promotions.isError && <ErrorState error={promotions.error} onRetry={reload} />}
              <SelectField
                label={t("social.choosePromotion")}
                value={promotionId}
                disabled={busy}
                options={[
                  { value: "", label: t("social.choosePromotion") },
                  ...(promotions.data?.promotions ?? []).map((row) => ({
                    value: row.id,
                    label: `${row.name} · ${row.code}`,
                  })),
                ]}
                onChange={setPromotionId}
              />
              <div className="flex flex-wrap gap-3">
                {promotionPage > 1 && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPromotionPage(1);
                      setPromotionId("");
                    }}
                  >
                    {t("social.first")}
                  </Button>
                )}
                {promotions.data &&
                  promotionPage * promotions.data.pagination.pageSize <
                    promotions.data.pagination.total && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPromotionPage((value) => value + 1);
                        setPromotionId("");
                      }}
                    >
                      {t("social.moreOffers")}
                    </Button>
                  )}
              </div>
            </>
          )}
          {kind === "review" && (
            <>
              {reviews.isPending && <Skeleton className="h-12" />}
              {reviews.isError && <ErrorState error={reviews.error} onRetry={reload} />}
              <SelectField
                label={t("social.chooseReview")}
                value={reviewId}
                disabled={busy}
                options={[
                  { value: "", label: t("social.chooseReview") },
                  ...(reviews.data?.reviews ?? [])
                    .filter(
                      (row) =>
                        row.allowSocialUse && row.sourceEligible && row.status === "published",
                    )
                    .map((row) => ({
                      value: row.id,
                      label: `${t("social.reviewSource", { name: row.publicName ?? "" })} · ${row.rating} / 5`,
                    })),
                ]}
                onChange={setReviewId}
              />
              <div className="flex flex-wrap gap-3">
                {reviewBefore && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setReviewBefore(undefined);
                      setReviewId("");
                    }}
                  >
                    {t("social.first")}
                  </Button>
                )}
                {reviews.data?.nextBefore && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setReviewBefore(reviews.data?.nextBefore ?? undefined);
                      setReviewId("");
                    }}
                  >
                    {t("social.moreReviews")}
                  </Button>
                )}
              </div>
            </>
          )}
          <SelectField
            label={t("social.format")}
            value={format}
            disabled={busy}
            options={(["square", "portrait", "story"] as const).map((value) => ({
              value,
              label: t(`social.${value}`),
            }))}
            onChange={(value) =>
              setFormat(value === "square" ? "square" : value === "story" ? "story" : "portrait")
            }
          />
          <SelectField
            label={t("social.palette")}
            value={palette}
            disabled={busy}
            options={(["cream", "rose", "ink"] as const).map((value) => ({
              value,
              label: t(`social.${value}`),
            }))}
            onChange={(value) =>
              setPalette(value === "rose" ? "rose" : value === "ink" ? "ink" : "cream")
            }
          />
          {!sourceReady &&
            ((kind === "review" && reviewId) ||
              (kind !== "review" && serviceId && (kind !== "promotion" || promotionId))) && (
              <p role="status" className="text-muted">
                {t("social.unavailable")}
              </p>
            )}
          <div className="flex flex-wrap gap-3">
            <Button disabled={!sourceReady || busy} onClick={() => void prepare()}>
              {t("social.prepare")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={reload}>
              {t("social.reload")}
            </Button>
          </div>
          {error !== undefined && (
            <p
              role="alert"
              className="rounded-lg border border-danger-fg/30 bg-danger-soft p-4 text-danger-fg"
            >
              {errorText}
            </p>
          )}
          {feedback && (
            <p role="status" className="text-sm text-muted">
              {t(
                feedback === "download"
                  ? "social.started"
                  : feedback === "copied"
                    ? "acquisition.copied"
                    : "acquisition.copyError",
              )}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-5 rounded-xl border border-line bg-surface p-5">
          {busy && !preview && <Skeleton className="h-80" />}
          {preview && (
            <>
              <figure>
                <img
                  src={preview.dataUrl}
                  alt={t("social.preview", { title: preview.title })}
                  className="mx-auto max-h-[42rem] w-full rounded-lg object-contain"
                />
                <figcaption className="sr-only">{preview.caption}</figcaption>
              </figure>
              <TextAreaField
                label={t("social.caption")}
                value={preview.caption}
                readOnly
                rows={8}
              />
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1.5"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>{t("social.confirm")}</span>
              </label>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={!reviewed || busy || !sourceReady}
                  onClick={() => void exportContent("png")}
                >
                  {t("social.download")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={!reviewed || busy || !sourceReady}
                  onClick={() => void exportContent("copy")}
                >
                  {t("social.copyCaption")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!reviewed || busy || !sourceReady}
                  onClick={() => void exportContent("caption")}
                >
                  {t("social.downloadCaption")}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
