import { publicOrigin } from "../lib/public-origin";
export function parseWidgetOrigins(raw = ""): string[] {
  const origins = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(publicOrigin),
    ),
  ];
  if (origins.length > 16) throw new Error("Configure at most 16 widget parent origins");
  return origins;
}
/** Only the public, read-only widget can be framed. Booking, accounts, API and admin keep DENY. */
export function applyWidgetFramePolicy(
  headers: Headers,
  pathname: string,
  origins: readonly string[],
) {
  if (pathname !== "/widget") return;
  const safe = origins.map(publicOrigin);
  const csp = (headers.get("content-security-policy") ?? "default-src 'none'")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors(?:\s|$)/i.test(part));
  csp.push(`frame-ancestors 'self'${safe.length ? ` ${safe.join(" ")}` : ""}`);
  headers.set("content-security-policy", csp.join("; "));
  if (safe.length) headers.delete("x-frame-options");
  else headers.set("x-frame-options", "SAMEORIGIN");
}
