import { afterAll, beforeAll } from "bun:test";

/** Swaps Bun's native Request/Response/Headers/fetch back in for server-side test files. */
export function useNativeWebApi() {
  const globals = globalThis as Record<string, unknown>;
  const native = globals.__nativeWebApi as Record<string, unknown>;
  const dom: Record<string, unknown> = {};
  beforeAll(() => {
    for (const key of Object.keys(native)) {
      dom[key] = globals[key];
      globals[key] = native[key];
    }
  });
  afterAll(() => {
    for (const key of Object.keys(native)) globals[key] = dom[key];
  });
}
