import type { ReactNode } from "react";
import { useI18n } from "~/i18n/react";

/** The image is anonymous generated editorial art; never a customer or salon portrait. */
export function AuthFrame({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  return (
    <div className="auth-frame page-container mx-auto grid w-full max-w-6xl gap-10 px-4 py-8 sm:px-6 lg:grid-cols-2 lg:gap-20 lg:py-14">
      <div className="auth-editorial hidden overflow-hidden lg:block" aria-hidden="true">
        <img
          src="/images/editorial/care-v1-800.webp"
          width="800"
          height="1000"
          alt=""
          decoding="async"
        />
      </div>
      <div className="auth-content min-w-0 self-center">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent-text">
          {locale === "en" ? "Your space at Sisters of Beauty" : "Tu espacio en Sisters of Beauty"}
        </p>
        {children}
      </div>
    </div>
  );
}
