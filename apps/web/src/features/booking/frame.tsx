import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageContainer } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { Stepper, type StepperStep } from "./components";
import {
  type BookingSearch,
  type BookingStep,
  canEnterStep,
  serializeBookingSearch,
} from "./search";
import { STEP_PATH } from "./use-booking";

const ORDER: BookingStep[] = ["services", "professional", "time", "review"];

/** Shared page frame of every booking step: progress, content column and the summary panel. */
export function BookingFrame({
  step,
  search,
  title,
  lead,
  children,
  summary,
  teamAccount = false,
  combinationUnavailable = false,
}: {
  step: BookingStep;
  search: BookingSearch;
  title: string;
  lead?: string;
  children: ReactNode;
  summary: ReactNode;
  teamAccount?: boolean;
  combinationUnavailable?: boolean;
}) {
  const { t } = useI18n();
  const current = ORDER.indexOf(step);
  const steps: StepperStep[] = ORDER.map((id, index) => ({
    id,
    label: t(`booking.step.${id}`),
    status: index < current ? "complete" : index === current ? "current" : "upcoming",
  }));

  return (
    <PageContainer width="max-w-6xl">
      <div className="booking-frame pt-6 pb-56 lg:pb-16" data-booking-step={step}>
        <Stepper
          steps={steps}
          label={t("booking.stepper.label")}
          renderStep={(item, content) =>
            item.status === "complete" && canEnterStep(search, item.id as BookingStep) ? (
              <Link
                to={STEP_PATH[item.id as BookingStep]}
                search={serializeBookingSearch(search)}
                className="rounded-md"
              >
                {content}
              </Link>
            ) : (
              content
            )
          }
        />
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <section aria-labelledby="step-title" className="booking-content min-w-0">
            <header className="mb-6">
              <h1 id="step-title" className="text-title">
                {title}
              </h1>
              {lead && <p className="mt-2 max-w-prose text-muted">{lead}</p>}
            </header>
            {teamAccount && step !== "review" && (
              <aside
                role="note"
                className="mb-5 space-y-3 rounded-lg border border-line bg-sunken p-4"
              >
                <p className="text-sm">{t("booking.review.staff.body")}</p>
                <Link to="/admin" className={buttonClasses({ variant: "secondary" })}>
                  {t("booking.review.staff.link")}
                </Link>
              </aside>
            )}
            {combinationUnavailable ? (
              <div className="space-y-3 rounded-lg border border-line p-4">
                <p role="alert">{t("combinations.unavailable")}</p>
                <Link to="/book" search={{}} className={buttonClasses({ variant: "secondary" })}>
                  {t("booking.professional.none.back")}
                </Link>
              </div>
            ) : (
              children
            )}
          </section>
          {summary}
        </div>
      </div>
    </PageContainer>
  );
}
