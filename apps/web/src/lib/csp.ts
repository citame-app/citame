/**
 * Content-Security-Policy for the server-rendered pages. TanStack Start streams inline
 * bootstrap scripts, so scripts are allowed by a fresh per-request nonce (never
 * `unsafe-inline`); the same nonce reaches the router through `ssr.nonce`, which stamps it on
 * every script and style tag it emits. Style ATTRIBUTES stay allowed because React inline
 * styles and the chart library use them; that cannot execute code.
 */

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function isWhatsAppSettingsPath(pathname: string): boolean {
  return pathname === "/admin/whatsapp" || pathname === "/admin/whatsapp/";
}

export function buildCsp({ nonce, https }: { nonce: string; https: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://sis.redsys.es https://sis-t.redsys.es:25443",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
