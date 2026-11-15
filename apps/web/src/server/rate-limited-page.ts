import { createTranslator, type Locale } from "../i18n";
import type { Theme } from "../lib/theme";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A self-contained answer for a visit the API rate-limited. It must work when the app itself
 * could not render (the very first lookups failed), so it has no scripts, no app CSS and no
 * hydration. Copy comes from the same message catalogue as the in-app notice.
 */
export function renderRateLimitedPage({
  locale,
  theme,
  retryAfterSeconds,
  nonce,
}: {
  locale: Locale;
  theme?: Theme;
  retryAfterSeconds: number;
  nonce: string;
}): string {
  const t = createTranslator(locale);
  const title = t("error.rateLimited.title");
  const body = t("error.rateLimited.body", { count: retryAfterSeconds });
  return `<!DOCTYPE html><html lang="${locale}"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fbf8f5;--fg:#2a2226;--muted:#5d5157;--accent:#8a3a52;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171214;--fg:#f3ece9;--muted:#c4b8bc;--accent:#e6a3b8;--accent-fg:#171214}}
:root[data-theme="dark"]{--bg:#171214;--fg:#f3ece9;--muted:#c4b8bc;--accent:#e6a3b8;--accent-fg:#171214}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.5rem;color:var(--muted)}
a{display:inline-block;padding:.75rem 1.25rem;border-radius:.5rem;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none}
a:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
</style></head><body><main role="alert"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><a href="">${escapeHtml(t("common.retry"))}</a></main></body></html>`;
}
