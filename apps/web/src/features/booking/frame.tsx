import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageContainer } from "~/components/pages";
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
}: {
  step: BookingStep;
  search: BookingSearch;
  title: string;
  lead?: string;
  children: ReactNode;
  summary: ReactNode;
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
      <div className="pt-6 pb-56 lg:pb-16">
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
          <section aria-labelledby="step-title" className="min-w-0">
            <header className="mb-6">
              <h1 id="step-title" className="text-title">
                {title}
              </h1>
              {lead && <p className="mt-2 max-w-prose text-muted">{lead}</p>}
            </header>
            {children}
          </section>
          {summary}
        </div>
      </div>
    </PageContainer>
  );
}
