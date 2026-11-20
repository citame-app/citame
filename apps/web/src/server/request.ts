import { queryOptions } from "@tanstack/react-query";
import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { api, serverEndpoints } from "~/lib/api/instance";
import { type Bootstrap, bootstrapForRequest } from "./bootstrap";
import { resolveSession } from "./session";

/** Use only in guarded route loaders. The credential stays in the server-side request. */
export const routeEndpoints = createIsomorphicFn()
  .server(() => {
    const headers = getRequestHeaders();
    return serverEndpoints(headers.get("cookie"), headers.get("x-request-id"));
  })
  .client(api);

export type { Bootstrap } from "./bootstrap";

/**
 * Everything the very first render needs and that depends on the visitor's cookies: language,
 * theme and the signed-in user. It runs on the server so the HTML is already correct.
 */
export const loadBootstrap = createServerFn({ method: "GET" }).handler(
  async (): Promise<Bootstrap> => {
    const headers = getRequestHeaders();
    const cookie = headers.get("cookie");
    return bootstrapForRequest(headers, () =>
      resolveSession(() => serverEndpoints(cookie, headers.get("x-request-id")).me()),
    );
  },
);

export const bootstrapQuery = queryOptions({
  queryKey: ["bootstrap"],
  queryFn: () => loadBootstrap(),
  staleTime: 5 * 60_000,
});

const loadPublicBootstrap = createServerFn({ method: "GET" }).handler(
  async (): Promise<Bootstrap> => bootstrapForRequest(getRequestHeaders(), async () => null, true),
);
export const publicBootstrapQuery = queryOptions({
  queryKey: ["bootstrap-public"],
  queryFn: () => loadPublicBootstrap(),
  staleTime: 5 * 60_000,
});
