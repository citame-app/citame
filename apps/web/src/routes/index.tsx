import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { ChevronRightIcon, ClockIcon, SparkleIcon } from "~/components/ui/icons";
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

  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -right-24 size-[28rem] rounded-full bg-accent-soft opacity-70 blur-3xl"
        />
        <PageContainer width="max-w-6xl">
          <div className="relative grid items-center gap-10 py-12 sm:py-20 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="sob-rise">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-accent-text">
                {t("home.eyebrow")}
              </p>
              <h1 className="text-display">{t("home.title")}</h1>
              <p className="mt-5 max-w-lg text-lg text-muted">
                {t("home.lead", { name: salon.name })}
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link to="/book" className={buttonClasses({ size: "lg" })}>
                  {t("home.cta")}
                  <ChevronRightIcon />
                </Link>
                <a href="#services" className={buttonClasses({ size: "lg", variant: "secondary" })}>
                  {t("home.ctaSecondary")}
                </a>
              </div>
              <p className="mt-5 text-sm text-muted">
                {t("home.window", {
                  days: salon.maxDaysAhead,
                  timezone: salon.timezone.replaceAll("_", " "),
                })}
              </p>
              <Link
                to="/reviews"
                className="mt-4 inline-flex min-h-11 items-center text-accent-text underline underline-offset-4"
              >
                {t("reviews.title")}
              </Link>
            </div>
            <div
              aria-hidden="true"
              className="relative mx-auto hidden aspect-[4/5] w-full max-w-sm lg:block"
            >
              <div className="absolute inset-0 rounded-t-[999px] rounded-b-3xl bg-gradient-to-b from-accent-soft via-sunken to-surface shadow-md" />
              <div className="absolute inset-6 rounded-t-[999px] rounded-b-2xl border border-accent/30" />
              <span className="absolute inset-0 grid place-items-center text-accent-text">
                <SparkleIcon width={72} height={72} strokeWidth={1.1} />
              </span>
            </div>
          </div>
        </PageContainer>
      </section>

      <section id="services" aria-labelledby="services-title" className="scroll-mt-20 py-12">
        <PageContainer width="max-w-6xl">
          <h2 id="services-title" className="text-title">
            {t("home.services.title")}
          </h2>
          <p className="mt-2 max-w-prose text-muted">{t("home.services.lead")}</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => (
              <li key={service.id}>
                <Link
                  to="/book"
                  search={{ services: service.id }}
                  className="group flex h-full flex-col rounded-xl border border-line bg-surface p-5 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="font-display text-xl font-semibold">{service.name}</span>
                    <span className="font-display text-xl text-accent-text">
                      {formatMoney(service.priceCents, service.currency, locale)}
                    </span>
                  </span>
                  {service.description && (
                    <span className="mt-1 text-muted">{service.description}</span>
                  )}
                  <span className="mt-4 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-muted">
                      <ClockIcon width={16} height={16} />
                      {formatDuration(service.durationMinutes, locale)}
                    </span>
                    <span className="inline-flex items-center gap-1 font-medium text-accent-text">
                      {t("home.services.book")}
                      <ChevronRightIcon
                        width={16}
                        height={16}
                        className="transition-transform group-hover:translate-x-0.5"
                      />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </PageContainer>
      </section>

      <section aria-labelledby="how-title" className="py-12">
        <PageContainer width="max-w-6xl">
          <h2 id="how-title" className="text-title">
            {t("home.how.title")}
          </h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-3">
            {steps.map((key, index) => (
              <li key={key} className="rounded-xl border border-line bg-surface p-5">
                <span className="mb-3 grid size-9 place-items-center rounded-full bg-accent-soft font-display text-lg font-semibold text-accent-soft-fg">
                  {index + 1}
                </span>
                <p className="font-medium">{t(key)}</p>
              </li>
            ))}
          </ol>
        </PageContainer>
      </section>

      {staff.length > 0 && (
        <section aria-labelledby="team-title" className="py-12">
          <PageContainer width="max-w-6xl">
            <h2 id="team-title" className="text-title">
              {t("home.team.title")}
            </h2>
            <ul className="mt-6 flex flex-wrap gap-3">
              {staff.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center gap-3 rounded-full border border-line bg-surface py-1.5 pr-5 pl-1.5"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-10 place-items-center rounded-full bg-accent-soft font-display text-lg font-semibold text-accent-soft-fg"
                  >
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="font-medium">{member.displayName}</span>
                </li>
              ))}
            </ul>
          </PageContainer>
        </section>
      )}

      <section className="py-12">
        <PageContainer width="max-w-6xl">
          <div className="rounded-2xl bg-accent-soft p-8 text-center sm:p-12">
            <h2 className="text-title text-accent-soft-fg">{t("home.final.title")}</h2>
            <Link to="/book" className={`${buttonClasses({ size: "lg" })} mt-6`}>
              {t("home.cta")}
            </Link>
          </div>
        </PageContainer>
      </section>
    </>
  );
}
