import type { MeResponse } from "@sob/contracts";
import { type Locale, resolveLocale } from "~/i18n";
import { parseThemeCookie, type Theme } from "~/lib/theme";
export interface Bootstrap {
  locale: Locale;
  theme: Theme | undefined;
  session: MeResponse | null;
}
/** Public embeds never resolve or serialize a visitor's account, even if a cookie is present. */
export async function bootstrapForRequest(
  headers: Headers,
  readSession: () => Promise<MeResponse | null>,
  publicOnly = false,
): Promise<Bootstrap> {
  const cookie = headers.get("cookie");
  return {
    locale: resolveLocale({ cookie, acceptLanguage: headers.get("accept-language") }),
    theme: parseThemeCookie(cookie),
    session: !publicOnly && cookie ? await readSession() : null,
  };
}
