import type { SalonResponse } from "@sob/contracts";
import { useI18n } from "~/i18n/react";

export function PublicBusinessProfile({
  profile,
}: {
  profile: NonNullable<SalonResponse["profile"]>;
}) {
  const { t } = useI18n();
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
  if (!Object.values(profile).some((value) => (Array.isArray(value) ? value.length : value)))
    return null;
  return (
    <section className="editorial-section" aria-labelledby="public-business-heading">
      <div className="wrap editorial-wrap grid gap-8 lg:grid-cols-2">
        <div className="editorial-section-heading">
          {category && <p className="editorial-kicker">{category}</p>}
          <h2 id="public-business-heading">{t("home.business.title")}</h2>
          {description && <p className="break-words">{description}</p>}
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
                    className="text-accent-text underline"
                    href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                  >
                    {phone}
                  </a>
                </p>
              )}
              {email && (
                <p>
                  <a
                    className="text-accent-text underline"
                    href={`mailto:${encodeURIComponent(email)}`}
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
        </div>
      </div>
    </section>
  );
}
