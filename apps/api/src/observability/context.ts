import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request state carried through async calls, so any log line can name its request. */
export interface RequestScope {
  requestId: string;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

export const currentRequestId = (): string | undefined => requestScope.getStore()?.requestId;
