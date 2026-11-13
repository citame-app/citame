import { createContext, type ReactNode, useContext, useMemo } from "react";
import { createTranslator, type Locale, type Translator } from "./index";

interface I18nValue {
  locale: Locale;
  t: Translator;
  /** Salon IANA timezone every date is displayed in. */
  timeZone: string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  timeZone = "America/Argentina/Buenos_Aires",
  children,
}: {
  locale: Locale;
  timeZone?: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, timeZone, t: createTranslator(locale) }),
    [locale, timeZone],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
