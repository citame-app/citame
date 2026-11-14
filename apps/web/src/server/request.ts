import type { MeResponse } from "@sob/contracts";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { type Locale, resolveLocale } from "~/i18n";
import { ApiError } from "~/lib/api/client";
import { serverEndpoints } from "~/lib/api/instance";
import { parseThemeCookie, type Theme } from "~/lib/theme";

export interface Bootstrap {
  locale: Locale;
  theme: Theme | undefined;
  session: MeResponse | null;
}

/**
 * Everything the very first render needs and that depends on the visitor's cookies: language,
 * theme and the signed-in user. It runs on the server so the HTML is already correct.
 */
export const loadBootstrap = createServerFn({ method: "GET" }).handler(
  async (): Promise<Bootstrap> => {
    const headers = getRequestHeaders();
    const cookie = headers.get("cookie");
    const locale = resolveLocale({ cookie, acceptLanguage: headers.get("accept-language") });
    const theme = parseThemeCookie(cookie);
    let session: MeResponse | null = null;
    if (cookie) {
      try {
        session = await serverEndpoints(cookie, headers.get("x-request-id")).me();
      } catch (error) {
        // 401 simply means "signed out"; anything else must not break public pages.
        if (!(error instanceof ApiError && error.status === 401)) {
          console.error("session lookup failed", error);
        }
      }
    }
    return { locale, theme, session };
  },
);

export const bootstrapQuery = queryOptions({
  queryKey: ["bootstrap"],
  queryFn: () => loadBootstrap(),
  staleTime: 5 * 60_000,
});
