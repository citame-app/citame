import { Link, useRouter } from "@tanstack/react-router";
import { useI18n } from "~/i18n/react";
import { buttonClasses } from "./ui/button";
import { EmptyState, ErrorState } from "./ui/states";

export function PageContainer({
  children,
  width = "max-w-5xl",
}: {
  children: React.ReactNode;
  width?: string;
}) {
  return <div className={`page-container mx-auto w-full ${width} px-4 sm:px-6`}>{children}</div>;
}

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <PageContainer width="max-w-xl">
      <div className="py-16">
        <EmptyState title={t("notFound.title")} description={t("notFound.body")}>
          <Link to="/" className={buttonClasses({ variant: "primary" })}>
            {t("notFound.home")}
          </Link>
        </EmptyState>
      </div>
    </PageContainer>
  );
}

export function ErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  return (
    <PageContainer width="max-w-xl">
      <div className="py-16">
        <ErrorState
          error={error}
          onRetry={() => {
            reset?.();
            void router.invalidate();
          }}
        />
      </div>
    </PageContainer>
  );
}

/** Heading block shared by every page: one h1, optional lead text. */
export function PageHeading({
  title,
  lead,
  eyebrow,
}: {
  title: string;
  lead?: string;
  eyebrow?: string;
}) {
  return (
    <header className="page-heading mb-8">
      {eyebrow && (
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.14em] text-accent-text">
          {eyebrow}
        </p>
      )}
      <h1 className="text-title">{title}</h1>
      {lead && <p className="mt-2 max-w-prose text-lg text-muted">{lead}</p>}
    </header>
  );
}
