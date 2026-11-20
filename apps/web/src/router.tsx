import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ErrorPage, NotFoundPage } from "./components/pages";
import { createNonce, isWhatsAppSettingsPath } from "./lib/csp";
import { routeTree } from "./routeTree.gen";

/** A fresh CSP nonce per server render. The browser rebuilds the router from the dehydrated state. */
const getSsrOptions = createIsomorphicFn()
  .server(() => ({ nonce: createNonce() }))
  .client(() => undefined);

export function getRouter() {
  // One QueryClient per router: Start builds a router per SSR request, so no cache is shared
  // between visitors.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          failureCount < 2 && !(error instanceof Error && error.name === "ApiError"),
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      documentAllowsMetaPopup:
        typeof document === "undefined"
          ? undefined
          : isWhatsAppSettingsPath(window.location.pathname),
    },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 250,
    defaultPendingMinMs: 300,
    // Older engines navigate normally. Typed transitions let us skip URL-only UI changes.
    defaultViewTransition:
      typeof document !== "undefined" &&
      typeof document.startViewTransition === "function" &&
      window.CSS?.supports?.("selector(:active-view-transition-type(page-navigation))")
        ? {
            types: ({ fromLocation, toLocation, pathChanged }) =>
              fromLocation &&
              pathChanged &&
              fromLocation.pathname !== "/widget" &&
              toLocation.pathname !== "/widget" &&
              !window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? ["page-navigation"]
                : false,
          }
        : false,
    scrollRestoration: true,
    defaultErrorComponent: ErrorPage,
    defaultNotFoundComponent: NotFoundPage,
    ssr: getSsrOptions(),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
