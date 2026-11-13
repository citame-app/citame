import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ToastHost } from "../src/components/ui/toast";
import type { Locale } from "../src/i18n";
import { I18nProvider } from "../src/i18n/react";

export function renderApp(ui: ReactElement, options: { locale?: Locale; timeZone?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider locale={options.locale ?? "en"} timeZone={options.timeZone}>
          <ToastHost>{ui}</ToastHost>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}
