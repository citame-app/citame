import { useRouterState } from "@tanstack/react-router";

/**
 * The page's query string exactly as the browser has it. The router re-serializes validated
 * search params (numbers are parsed, repeated keys collapse), and an OAuth authorization query
 * is signed by the server over its exact original form, so it must never go through that.
 */
export function useRawSearch(): string {
  const routed = useRouterState({ select: (s) => s.location.searchStr });
  return typeof window === "undefined" ? routed : window.location.search;
}
