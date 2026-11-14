import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ErrorPage, NotFoundPage } from "./components/pages";
import { createNonce } from "./lib/csp";
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
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 250,
    defaultPendingMinMs: 300,
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
