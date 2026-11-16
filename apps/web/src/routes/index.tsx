import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PageContainer } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { ChevronRightIcon, ClockIcon } from "~/components/ui/icons";
import { Skeleton } from "~/components/ui/states";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { formatDuration, formatMoney } from "~/lib/format";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(servicesQuery),
      context.queryClient.ensureQueryData(staffQuery),
      context.queryClient.ensureQueryData(salonQuery),
    ]);
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: salon.name,
        description: t("seo.home.description", { name: salon.name }),
        siteName: salon.name,
        locale,
      }),
    };
  },
  pendingComponent: HomeSkeleton,
  component: Home,
});

function HomeSkeleton() {
  return (
    <PageContainer>
      <div className="space-y-6 py-16" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full max-w-xl" />
        <Skeleton className="h-6 w-full max-w-md" />
        <Skeleton className="h-12 w-48" />
      </div>
    </PageContainer>
  );
}

function Home() {
  const { t, locale } = useI18n();
  const { data: salon } = useSuspenseQuery(salonQuery);
  const { data: services } = useSuspenseQuery(servicesQuery);
  const { data: staff } = useSuspenseQuery(staffQuery);
  const steps = ["home.how.one", "home.how.two", "home.how.three"] as const;
  const momentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = momentRef.current;
    const entryId = "salon-motion-entry";
    if (!document.getElementById(entryId)) {
      const script = document.createElement("script");
      script.id = entryId;
      script.type = "module";
      script.src = "/taste-entry.js";
      document.head.appendChild(script);
    }
    window.dispatchEvent(new Event("sob:public-mounted"));
    return () => {
      window.dispatchEvent(new CustomEvent("sob:public-unmounted", { detail: element }));
    };
  }, []);

  return (
    <>
      <section className="hero hero--place salon-hero" data-enter="" aria-labelledby="home-title">
        <div className="wrap editorial-wrap">
          <div className="hero-text">
            <div className="hero__media salon-hero-media m-zoom" data-enter-media="">
              <img
                src="/images/editorial/hair-v1-1536.webp"
                srcSet="/images/editorial/hair-v1-640.webp 640w, /images/editorial/hair-v1-1024.webp 1024w, /images/editorial/hair-v1-1536.webp 1536w"
                sizes="(min-width: 1280px) 1152px, calc(100vw - 48px)"
                width="1536"
                height="1024"
                fetchPriority="high"
                alt={
                  locale === "en"
                    ? "Hair being gently combed, beauty editorial illustration"
                    : "Cuidado del cabello con un peine, ilustración editorial de belleza"
                }
              />
            </div>
            <div className="salon-hero-copy">
              <div>
                <p className="editorial-kicker">{salon.name}</p>
                <h1 id="home-title" data-enter-whole="">
                  {t("home.title")}
                </h1>
              </div>
              <div className="salon-hero-action">
                <p>{t("home.lead", { name: salon.name })}</p>
                <Link to="/book" className={buttonClasses({ size: "lg" })}>
                  {t("home.cta")}
                  <ChevronRightIcon />
                </Link>
                <p className="hero-fact">
                  {t("home.window", {
                    days: salon.maxDaysAhead,
                    timezone: salon.timezone.replaceAll("_", " "),
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        id="services"
        aria-labelledby="services-title"
        className="salon-offer editorial-section"
      >
        <div className="wrap editorial-wrap">
          <header className="editorial-section-heading">
            <h2 id="services-title">{t("home.services.title")}</h2>
            <p>{t("home.services.lead")}</p>
          </header>
          <div className="salon-offer-grid">
            <ul className="service-menu">
              {services.map((service) => (
                <li key={service.id}>
                  <Link
                    to="/book"
                    search={{ services: service.id }}
                    className="service-menu-row group"
                  >
                    <span className="min-w-0">
                      <span className="service-menu-name">{service.name}</span>
                      {service.description && (
                        <span className="mt-1 block text-muted">{service.description}</span>
                      )}
                      <span className="mt-2 flex items-center gap-1.5 text-sm text-muted">
                        <ClockIcon width={16} height={16} />
                        {formatDuration(service.durationMinutes, locale)}
                      </span>
                    </span>
                    <span className="service-menu-price">
                      {formatMoney(service.priceCents, service.currency, locale)}
                      <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent-text">
                        {t("home.services.book")}
                        <ChevronRightIcon width={16} height={16} />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <figure
              ref={momentRef}
              className="frame frame--photo salon-offer-photo m-zoom"
              data-moment="picture-develops"
              data-moment-opts='{"look":"film","duration":1600}'
            >
              <img
                src="/images/editorial/nails-v1-800.webp"
                srcSet="/images/editorial/nails-v1-480.webp 480w, /images/editorial/nails-v1-800.webp 800w"
                sizes="(min-width: 1024px) 45vw, 100vw"
                width="800"
                height="800"
                loading="lazy"
                decoding="async"
                alt={
                  locale === "en"
                    ? "Rose manicure on ivory linen, editorial illustration"
                    : "Manicura rosa sobre lino marfil, ilustración editorial"
                }
              />
            </figure>
          </div>
        </div>
      </section>

      <section aria-labelledby="how-title" className="salon-close editorial-section">
        <div className="wrap editorial-wrap">
          <header className="editorial-section-heading">
            <h2 id="how-title">{t("home.how.title")}</h2>
          </header>
          <ol className="booking-instructions">
            {steps.map((key, index) => (
              <li key={key}>
                <span aria-hidden="true">0{index + 1}</span>
                <p>{t(key)}</p>
              </li>
            ))}
          </ol>
          {staff.length > 0 && (
            <div className="salon-team">
              <p className="team-label">{t("home.team.title")}</p>
              <ul>
                {staff.map((member) => (
                  <li key={member.id}>
                    <span aria-hidden="true">{member.displayName.slice(0, 1).toUpperCase()}</span>
                    {member.displayName}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="salon-signoff">
            <p className="salon-wordmark">{salon.name}</p>
            <div>
              <h3>{t("home.final.title")}</h3>
              <Link to="/book" className={buttonClasses({ size: "lg" })}>
                {t("home.cta")}
                <ChevronRightIcon />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
