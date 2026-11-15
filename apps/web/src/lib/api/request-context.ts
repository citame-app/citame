/**
 * What the web server knows about the visit being rendered, readable from anywhere in the SSR
 * code (server functions, route loaders) without threading it through every call.
 *
 * The store itself lives in `server/request-context.ts` (it needs `node:async_hooks`, which must
 * not end up in the browser bundle). The two halves meet through a `globalThis` symbol because
 * the SSR bundle and `server.ts` are separate module graphs.
 */
export interface ServerRequestContext {
  /** The visitor's address as the web server determined it, or null when unknown. */
  visitorIp: string | null;
  requestId: string;
}

export const REQUEST_CONTEXT_KEY = Symbol.for("sob.web.requestContext");

interface ContextStore {
  getStore(): ServerRequestContext | undefined;
}

export function currentRequestContext(): ServerRequestContext | undefined {
  // In the browser nothing registers the store, so this is always undefined there.
  const store = (globalThis as Record<symbol, ContextStore | undefined>)[REQUEST_CONTEXT_KEY];
  return store?.getStore();
}
