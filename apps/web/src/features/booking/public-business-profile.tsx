import type {
  DateShiftRange,
  OpeningSchedule,
  PublicBusinessProfile as Profile,
  PublicProfileImage,
} from "@sob/contracts";
import { useEffect, useState } from "react";
import { useI18n } from "~/i18n/react";
import { formatDateWithYear, formatWallTime, localDateOf, WEEKDAY_ORDER } from "~/lib/format";

export function publicProfileImageUrl(image: Pick<PublicProfileImage, "id" | "version">) {
  return `/api/salon/profile/images/${image.id}/${image.version}`;
}

export function PublicBusinessProfile({
  profile,
  openingSchedule,
  gallery = [],
  initialDate,
  timezone,
}: {
  profile: Profile;
  openingSchedule?: OpeningSchedule;
  gallery?: PublicProfileImage[];
  initialDate: string;
  timezone: string;
}) {
  const { t, locale } = useI18n();
  const [localDate, setLocalDate] = useState(initialDate);
  useEffect(() => {
    if (!openingSchedule?.weekly && !openingSchedule?.exceptions.length) return;
    const refresh = () => setLocalDate(localDateOf(new Date().toISOString(), timezone));
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [openingSchedule, timezone]);
  const {
    address,
    phone,
    email,
    description,
    category,
    website,
    shop,
    instagram,
    rules,
    amenities,
    mobileService,
  } = profile;
  const weekly = openingSchedule?.weekly;
  const exceptions = openingSchedule?.exceptions.filter((entry) => entry.date >= localDate) ?? [];
  const today =
    exceptions.find((entry) => entry.date === localDate)?.ranges ??
    weekly?.[new Date(`${localDate}T12:00:00Z`).getUTCDay()];
  const hasDetails = [
    address,
    phone,
    email,
    description,
    category,
    website,
    shop,
    instagram,
    rules,
    amenities.length,
    mobileService,
    weekly,
    exceptions.length,
    gallery.length,
  ].some(Boolean);
  if (!hasDetails) return null;
  const hours = (ranges: DateShiftRange[]) =>
    ranges.length
      ? ranges
          .map(
            ({ startTime, endTime }) =>
              `${formatWallTime(startTime, locale)}–${formatWallTime(endTime, locale)}`,
          )
          .join(", ")
      : t("settings.opening.closed");
  return (
    <section className="py-12 sm:py-16" aria-labelledby="public-business-heading">
      <div className="wrap editorial-wrap grid gap-8 lg:grid-cols-2">
        <div className="editorial-section-heading">
          {category && <p className="editorial-kicker">{category}</p>}
          <h2 id="public-business-heading">{t("home.business.title")}</h2>
          {description && <p className="whitespace-pre-wrap break-words">{description}</p>}
          {rules && (
            <>
              <h3 className="text-heading">{t("settings.profile.rules")}</h3>
              <p className="break-words">{rules}</p>
            </>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          {(address || phone || email) && (
            <address className="space-y-2 break-words not-italic">
              {address && <p>{address}</p>}
              {phone && (
                <p>
                  <a
                    className="inline-flex min-h-11 items-center text-accent-text underline"
                    href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                  >
                    {phone}
                  </a>
                </p>
              )}
              {email && (
                <p>
                  <a
                    className="inline-flex min-h-11 items-center text-accent-text underline"
                    href={`mailto:${encodeURIComponent(email).replace("%40", "@")}`}
                  >
                    {email}
                  </a>
                </p>
              )}
            </address>
          )}
          {(website || shop || instagram) && (
            <div className="flex flex-wrap gap-x-4">
              {website && (
                <a
                  className="inline-flex min-h-11 items-center text-accent-text underline"
                  href={website}
                >
                  {t("home.business.website")}
                </a>
              )}
              {shop && (
                <a
                  className="inline-flex min-h-11 items-center text-accent-text underline"
                  href={shop}
                >
                  {t("home.business.shop")}
                </a>
              )}
              {instagram && (
                <a
                  className="inline-flex min-h-11 items-center text-accent-text underline"
                  href={instagram}
                >
                  Instagram
                </a>
              )}
            </div>
          )}
          {(amenities.length > 0 || mobileService) && (
            <ul className="flex flex-wrap gap-2">
              {amenities.map((item) => (
                <li key={item} className="rounded-full border border-line px-3 py-1 text-sm">
                  {t(`settings.profile.${item}`)}
                </li>
              ))}
              {mobileService && (
                <li className="rounded-full border border-line px-3 py-1 text-sm">
                  {t("settings.profile.mobileService")}
                </li>
              )}
            </ul>
          )}
          {(weekly || exceptions.length > 0) && (
            <div className="space-y-2">
              <h3 className="text-heading">{t("settings.opening.title")}</h3>
              {today && (
                <p className="text-sm">
                  <strong>{t("settings.opening.today")}</strong> · {hours(today)}
                </p>
              )}
            </div>
          )}
          {weekly && (
            <div className="space-y-2">
              <h4 className="font-medium">{t("settings.opening.regular")}</h4>
              <dl className="divide-y divide-line text-sm">
                {WEEKDAY_ORDER.map((day) => (
                  <div key={day} className="flex flex-wrap justify-between gap-x-3 py-2">
                    <dt>{t(`hours.day.${day}`)}</dt>
                    <dd className="tabular-nums">{hours(weekly[day] ?? [])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {exceptions.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">{t("settings.opening.exceptions")}</h4>
              <dl className="divide-y divide-line text-sm">
                {exceptions.map(({ date, ranges }) => (
                  <div key={date} className="flex flex-wrap justify-between gap-x-3 py-2">
                    <dt>
                      <time dateTime={date}>{formatDateWithYear(date, locale)}</time>
                    </dt>
                    <dd className="tabular-nums">{hours(ranges)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
        {gallery.length > 0 && (
          <section aria-labelledby="centre-gallery-heading" className="space-y-3 lg:col-span-2">
            <h3 className="text-heading" id="centre-gallery-heading">
              {t("settings.media.gallery")}
            </h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {gallery.map((image) => (
                <li key={image.id}>
                  <a
                    href={publicProfileImageUrl(image)}
                    className="block overflow-hidden rounded-lg bg-sunken"
                  >
                    <img
                      src={publicProfileImageUrl(image)}
                      alt={image.alt}
                      width={image.width}
                      height={image.height}
                      loading="lazy"
                      decoding="async"
                      className="aspect-[4/3] h-auto w-full object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
