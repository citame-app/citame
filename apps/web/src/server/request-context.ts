import { AsyncLocalStorage } from "node:async_hooks";
import {
  currentRequestContext,
  REQUEST_CONTEXT_KEY,
  type ServerRequestContext,
} from "../lib/api/request-context";

const storage = new AsyncLocalStorage<ServerRequestContext>();
(globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT_KEY] = storage;

/** Runs `fn` (and everything it awaits) with `context` as the current visit. */
export function runWithRequestContext<T>(context: ServerRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export { currentRequestContext };
