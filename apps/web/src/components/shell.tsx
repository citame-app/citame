import { useEffect, useState } from "react";
import { LOCALES, type Locale, localeCookieValue } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { effectiveTheme, nextTheme, type Theme, themeCookieValue } from "~/lib/theme";
import { MoonIcon, SunIcon } from "./ui/icons";

export function ThemeToggle({
  initial,
  onChange,
}: {
  initial: Theme | undefined;
  onChange?: (theme: Theme) => void;
}) {
  const { t } = useI18n();
  // Server and first client render agree on "light"; the OS preference is resolved after mount
  // so hydration never mismatches.
  const [current, setCurrent] = useState<Theme>(initial ?? "light");
  useEffect(() => {
    setCurrent(effectiveTheme(initial));
  }, [initial]);
  const target = nextTheme(current);

  function toggle() {
    setCurrent(target);
    document.documentElement.dataset.theme = target;
    document.cookie = themeCookieValue(target);
    onChange?.(target);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={target === "dark" ? t("theme.toDark") : t("theme.toLight")}
      className="inline-flex size-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-fg"
    >
      {current === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

const LOCALE_LABEL: Record<Locale, string> = { en: "English", "es-AR": "Español" };

export function LocaleSwitch({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="inline-flex rounded-md border border-line-strong p-0.5">
      <legend className="sr-only">{t("locale.label")}</legend>
      {LOCALES.map((option) => (
        <span key={option} className="relative">
          <input
            id={`locale-${option}`}
            type="radio"
            name="locale"
            className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
            checked={locale === option}
            onChange={() => {
              document.cookie = localeCookieValue(option);
              onChange(option);
            }}
          />
          <label
            htmlFor={`locale-${option}`}
            lang={option}
            className={cn(
              "flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded px-2.5 text-sm font-medium text-muted transition-colors",
              "peer-checked:bg-accent peer-checked:text-accent-fg peer-focus-visible:outline-3 peer-focus-visible:outline-ring",
            )}
          >
            <span aria-hidden="true" className="sm:hidden">
              {option === "en" ? "EN" : "ES"}
            </span>
            <span className="sr-only sm:not-sr-only">{LOCALE_LABEL[option]}</span>
          </label>
        </span>
      ))}
    </fieldset>
  );
}
